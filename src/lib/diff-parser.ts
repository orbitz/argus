// Unified diff parser
// Parses unified diff format into structured data

export type LineType = 'context' | 'add' | 'del' | 'header';

// Parse a single diff hunk (like from GitHub's diff_hunk field)
export function parseHunkString(hunkStr: string): DiffHunk {
  const lines = hunkStr.split('\n');
  const headerLine = lines[0];

  const headerMatch = headerLine.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!headerMatch) {
    // Fallback if no header
    return {
      header: hunkStr,
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      lines: [],
    };
  }

  const oldStart = parseInt(headerMatch[1], 10);
  const oldCount = headerMatch[2] ? parseInt(headerMatch[2], 10) : 1;
  const newStart = parseInt(headerMatch[3], 10);
  const newCount = headerMatch[4] ? parseInt(headerMatch[4], 10) : 1;

  let oldLineNum = oldStart;
  let newLineNum = newStart;
  const parsedLines: DiffLine[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    const firstChar = line[0];
    const content = line.slice(1);

    if (firstChar === '+') {
      parsedLines.push({
        type: 'add',
        content,
        oldLineNum: null,
        newLineNum: newLineNum++,
      });
    } else if (firstChar === '-') {
      parsedLines.push({
        type: 'del',
        content,
        oldLineNum: oldLineNum++,
        newLineNum: null,
      });
    } else {
      parsedLines.push({
        type: 'context',
        content,
        oldLineNum: oldLineNum++,
        newLineNum: newLineNum++,
      });
    }
  }

  return {
    header: headerLine,
    oldStart,
    oldCount,
    newStart,
    newCount,
    lines: parsedLines,
  };
}

export interface DiffLine {
  type: LineType;
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
  // For inline comment anchoring
  position?: number; // 1-indexed position in the diff
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
  oldMode?: string;
  newMode?: string;
  /** Move cross-links: set only on cards produced by expandRenamedFile. */
  movedTo?: string;
  movedFrom?: string;
}

export interface ParsedDiff {
  files: DiffFile[];
}

// Parse hunk header: @@ -old_start,old_count +new_start,new_count @@
function parseHunkHeader(header: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} {
  const match = header.match(
    /@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
  );

  if (!match) {
    throw new Error(`Invalid hunk header: ${header}`);
  }

  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] ? parseInt(match[4], 10) : 1,
  };
}

// Parse the file header to extract paths
function parseFileHeader(lines: string[], startIndex: number): {
  oldPath: string;
  newPath: string;
  nextIndex: number;
  oldMode?: string;
  newMode?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  isBinary: boolean;
} {
  let oldPath = '';
  let newPath = '';
  let oldMode: string | undefined;
  let newMode: string | undefined;
  let status: 'added' | 'deleted' | 'modified' | 'renamed' = 'modified';
  let isBinary = false;
  let i = startIndex;

  // Parse diff header lines
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      // Extract paths from diff --git a/path b/path
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        oldPath = match[1];
        newPath = match[2];
      }
      i++;
    } else if (line.startsWith('old mode')) {
      oldMode = line.substring(9).trim();
      i++;
    } else if (line.startsWith('new mode')) {
      newMode = line.substring(9).trim();
      i++;
    } else if (line.startsWith('new file mode')) {
      status = 'added';
      newMode = line.substring(14).trim();
      i++;
    } else if (line.startsWith('deleted file mode')) {
      status = 'deleted';
      oldMode = line.substring(18).trim();
      i++;
    } else if (line.startsWith('similarity index') || line.startsWith('rename from') || line.startsWith('rename to')) {
      if (line.startsWith('rename')) {
        status = 'renamed';
      }
      i++;
    } else if (line.startsWith('index')) {
      i++;
    } else if (line.startsWith('Binary files')) {
      isBinary = true;
      i++;
      break;
    } else if (line.startsWith('---')) {
      // Parse old file path
      const path = line.substring(4).trim();
      if (path !== '/dev/null') {
        oldPath = path.startsWith('a/') ? path.substring(2) : path;
      }
      i++;
    } else if (line.startsWith('+++')) {
      // Parse new file path
      const path = line.substring(4).trim();
      if (path !== '/dev/null') {
        newPath = path.startsWith('b/') ? path.substring(2) : path;
      }
      i++;
      break;
    } else if (line.startsWith('@@')) {
      // Reached hunk without --- +++
      break;
    } else {
      i++;
    }
  }

  return {
    oldPath: oldPath || newPath,
    newPath: newPath || oldPath,
    nextIndex: i,
    oldMode,
    newMode,
    status,
    isBinary,
  };
}

// Parse a single hunk
function parseHunk(
  lines: string[],
  startIndex: number,
  positionOffset: number
): {
  hunk: DiffHunk;
  nextIndex: number;
  position: number;
} {
  const headerLine = lines[startIndex];
  const { oldStart, oldCount, newStart, newCount } = parseHunkHeader(headerLine);

  const hunk: DiffHunk = {
    header: headerLine,
    oldStart,
    oldCount,
    newStart,
    newCount,
    lines: [],
  };

  let oldLineNum = oldStart;
  let newLineNum = newStart;
  let i = startIndex + 1;
  let position = positionOffset + 1; // Position starts at 1 after the hunk header

  while (i < lines.length) {
    const line = lines[i];

    // Check for next file or hunk
    if (line.startsWith('diff --git') || line.startsWith('@@')) {
      break;
    }

    if (line.length === 0 || line === '\\ No newline at end of file') {
      i++;
      continue;
    }

    const prefix = line[0];
    const content = line.substring(1);

    if (prefix === ' ') {
      hunk.lines.push({
        type: 'context',
        content,
        oldLineNum,
        newLineNum,
        position,
      });
      oldLineNum++;
      newLineNum++;
    } else if (prefix === '+') {
      hunk.lines.push({
        type: 'add',
        content,
        oldLineNum: null,
        newLineNum,
        position,
      });
      newLineNum++;
    } else if (prefix === '-') {
      hunk.lines.push({
        type: 'del',
        content,
        oldLineNum,
        newLineNum: null,
        position,
      });
      oldLineNum++;
    }

    i++;
    position++;
  }

  return { hunk, nextIndex: i, position };
}

// Parse a single file diff
function parseFileDiff(
  lines: string[],
  startIndex: number
): {
  file: DiffFile;
  nextIndex: number;
} {
  const {
    oldPath,
    newPath,
    nextIndex: headerEnd,
    oldMode,
    newMode,
    status,
    isBinary,
  } = parseFileHeader(lines, startIndex);

  const file: DiffFile = {
    oldPath,
    newPath,
    status,
    hunks: [],
    additions: 0,
    deletions: 0,
    isBinary,
    oldMode,
    newMode,
  };

  if (isBinary) {
    return { file, nextIndex: headerEnd };
  }

  let i = headerEnd;
  let position = 0;

  // Parse all hunks for this file
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      // Next file
      break;
    }

    if (line.startsWith('@@')) {
      const { hunk, nextIndex, position: newPos } = parseHunk(lines, i, position);
      file.hunks.push(hunk);
      i = nextIndex;
      position = newPos;

      // Count additions/deletions
      for (const diffLine of hunk.lines) {
        if (diffLine.type === 'add') file.additions++;
        if (diffLine.type === 'del') file.deletions++;
      }
    } else {
      i++;
    }
  }

  return { file, nextIndex: i };
}

// Main parse function
export function parseDiff(diffText: string): ParsedDiff {
  const lines = diffText.split('\n');
  const files: DiffFile[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      const { file, nextIndex } = parseFileDiff(lines, i);
      files.push(file);
      i = nextIndex;
    } else {
      i++;
    }
  }

  return { files };
}

// Parse a single file's patch (from GitHub API)
export function parsePatch(
  patch: string,
  filename: string,
  status: string
): DiffFile {
  const lines = patch.split('\n');
  const file: DiffFile = {
    oldPath: filename,
    newPath: filename,
    status: status as DiffFile['status'],
    hunks: [],
    additions: 0,
    deletions: 0,
    isBinary: false,
  };

  let i = 0;
  let position = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('@@')) {
      const { hunk, nextIndex, position: newPos } = parseHunk(lines, i, position);
      file.hunks.push(hunk);
      i = nextIndex;
      position = newPos;

      for (const diffLine of hunk.lines) {
        if (diffLine.type === 'add') file.additions++;
        if (diffLine.type === 'del') file.deletions++;
      }
    } else {
      i++;
    }
  }

  return file;
}

// Get line count for display purposes
export function getLineCount(file: DiffFile): number {
  let count = 0;
  for (const hunk of file.hunks) {
    count += hunk.lines.length + 1; // +1 for hunk header
  }
  return count;
}

// Truncate a file's hunks to a max number of lines
export function truncateFile(file: DiffFile, maxLines: number): {
  truncatedFile: DiffFile;
  wasTruncated: boolean;
  totalLines: number;
} {
  const totalLines = getLineCount(file);

  if (totalLines <= maxLines) {
    return { truncatedFile: file, wasTruncated: false, totalLines };
  }

  const truncatedFile: DiffFile = {
    ...file,
    hunks: [],
  };

  let lineCount = 0;
  let addCount = 0;
  let delCount = 0;

  for (const hunk of file.hunks) {
    if (lineCount >= maxLines) break;

    const remainingLines = maxLines - lineCount - 1; // -1 for hunk header
    if (remainingLines <= 0) break;

    if (hunk.lines.length <= remainingLines) {
      truncatedFile.hunks.push(hunk);
      lineCount += hunk.lines.length + 1;
      for (const line of hunk.lines) {
        if (line.type === 'add') addCount++;
        if (line.type === 'del') delCount++;
      }
    } else {
      // Truncate this hunk
      const truncatedHunk: DiffHunk = {
        ...hunk,
        lines: hunk.lines.slice(0, remainingLines),
      };
      truncatedFile.hunks.push(truncatedHunk);
      lineCount += remainingLines + 1;
      for (const line of truncatedHunk.lines) {
        if (line.type === 'add') addCount++;
        if (line.type === 'del') delCount++;
      }
      break;
    }
  }

  truncatedFile.additions = addCount;
  truncatedFile.deletions = delCount;

  return { truncatedFile, wasTruncated: true, totalLines };
}
