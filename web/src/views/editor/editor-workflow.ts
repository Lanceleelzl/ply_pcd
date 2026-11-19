import type { EditorState } from '../../api/gaussian-editor-api';

export function moveLodFile<T>(files: T[], paths: string[], index: number, offset: -1 | 1) {
  const destination = index + offset;
  if (index < 0 || index >= files.length || destination < 0 || destination >= files.length)
    return { files: [...files], paths: [...paths] };
  const orderedFiles = [...files], orderedPaths = [...paths];
  [orderedFiles[index], orderedFiles[destination]] = [orderedFiles[destination], orderedFiles[index]];
  [orderedPaths[index], orderedPaths[destination]] = [orderedPaths[destination], orderedPaths[index]];
  return { files: orderedFiles, paths: orderedPaths };
}

export function resultSnapshot(version: { state?: EditorState }): EditorState | null {
  return version.state ? JSON.parse(JSON.stringify(version.state)) as EditorState : null;
}
