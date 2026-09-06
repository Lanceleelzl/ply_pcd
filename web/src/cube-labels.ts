// Labels stay in the face plane; turn upside-down text within that plane only.
export function createCubeLabels(cube: HTMLElement): () => void {
  const faces = Array.from(cube.querySelectorAll<HTMLElement>('.cube-face')).map(face => {
    const label = document.createElement('span');
    label.className = 'cube-face-label';
    label.textContent = face.textContent;
    face.replaceChildren(label);
    return { label, faceMatrix: new DOMMatrix(getComputedStyle(face).transform) };
  });
  return () => {
    const cubeMatrix = new DOMMatrix(cube.style.transform);
    for (const { label, faceMatrix } of faces) {
      const faceView = cubeMatrix.multiply(faceMatrix);
      label.style.visibility = faceView.m33 > 0 ? 'visible' : 'hidden';
      label.style.transform = `translate(-50%, -50%) rotate(${faceView.m22 < 0 ? 180 : 0}deg)`;
    }
  };
}
