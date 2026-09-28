// Rename expansion: one `renamed` file record becomes two card records.
//
// Argus renders one card per record, so a moved file needs two records — a delete
// at the old path and an add at the new path — to render as a delete + add split
// instead of the old single "Binary file not shown" card. Every source that feeds
// a file list (GitHub's PR files, commit files, compare files, local `git diff`)
// funnels through this one function, so the split cannot drift per call site.

/** The record shape every file-list source provides (PRFile, git diff records). */
export interface SplitSourceFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** GitHub field / git `--name-status` column 1: the path before a move. */
  previous_filename?: string;
  patch?: string;
  sha?: string;
  /** Delete card of a move: where the file went. Threaded onto DiffFile. */
  movedTo?: string;
  /** Add card of a move: where the file came from. Threaded onto DiffFile. */
  movedFrom?: string;
}

/**
 * Expand a `renamed` record into its delete and add cards; pass everything else
 * through untouched.
 *
 * The delete card carries no patch, no stats and no blob SHA: it exists to show
 * the vacated path, and that path holds no blob in the head tree. Its review state
 * is keyed on the moved blob's SHA instead (the caller maps the old path to it),
 * so a review of the card dies when the moved file's content changes. The add
 * card keeps the original record's patch, stats and SHA — it is the reviewable
 * half and keeps GitHub's `previous_filename` for the header cross-link.
 */
export function expandRenamedFile(file: SplitSourceFile): SplitSourceFile[] {
  if (file.status !== 'renamed' || !file.previous_filename) {
    return [file];
  }

  const oldPath = file.previous_filename;
  const newPath = file.filename;

  const deleteCard: SplitSourceFile = {
    ...file,
    filename: oldPath,
    previous_filename: undefined,
    status: 'deleted',
    additions: 0,
    deletions: 0,
    patch: undefined,
    sha: undefined,
    movedTo: newPath,
    movedFrom: undefined,
  };

  const addCard: SplitSourceFile = {
    ...file,
    status: 'added',
    movedTo: undefined,
    movedFrom: oldPath,
  };

  return [deleteCard, addCard];
}
