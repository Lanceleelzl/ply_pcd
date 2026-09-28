interface PickedFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

export interface PickedDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<PickedFileHandle | PickedDirectoryHandle>;
}

async function collectDirectoryFiles(
  directory: PickedDirectoryHandle,
  prefix: string,
  files: File[],
  paths: string[],
): Promise<void> {
  const entries: (PickedFileHandle | PickedDirectoryHandle)[] = [];
  for await (const entry of directory.values()) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.kind === 'file') {
      files.push(await entry.getFile());
      paths.push(relative);
    } else {
      await collectDirectoryFiles(entry, relative, files, paths);
    }
  }
}

export async function pickDirectory(fallback: () => void): Promise<{
  name: string; files: File[]; paths: string[];
} | null> {
  const picker = (window as unknown as {
    showDirectoryPicker?: () => Promise<PickedDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) {
    fallback();
    return null;
  }
  try {
    const directory = await picker();
    const files: File[] = [];
    const paths: string[] = [];
    await collectDirectoryFiles(directory, directory.name, files, paths);
    return { name: directory.name, files, paths };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}
