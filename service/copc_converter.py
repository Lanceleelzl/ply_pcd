"""Local LAS to COPC converter used by the desktop service and CLI."""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def source_wkt(source):
    # Some LAS 1.2 surveys carry WKT even though the legacy header advertises GeoTIFF.
    with source.open("rb") as stream:
        header = stream.read(227)
        stream.seek(struct.unpack_from("<H", header, 94)[0])
        for _ in range(struct.unpack_from("<I", header, 100)[0]):
            record = stream.read(54)
            record_id, length = struct.unpack_from("<HH", record, 18)
            data = stream.read(length)
            if record[2:18].rstrip(b"\0 ") == b"LASF_Projection" and record_id == 2112:
                return data.rstrip(b"\0").decode()
    return None


def validate_companion(source, destination):
    def header(path):
        with path.open("rb") as f:
            h = f.read(375)
            if h[:4] != b"LASF" or len(h) < 227:
                raise ValueError("点云文件头无效")
            legacy = struct.unpack_from("<I", h, 107)[0]
            count = struct.unpack_from("<Q", h, 247)[0] or legacy if h[25] >= 4 else legacy
            f.seek(struct.unpack_from("<H", h, 94)[0])
            return count, struct.unpack_from("<6d", h, 179), struct.unpack_from("<3d", h, 131), f.read(22)
    count, bounds, _, _ = header(source)
    actual, other, scale, record = header(destination)
    if (record[2:18].rstrip(b"\0 ") != b"copc" or record[18:20] != b"\x01\0"
            or actual != count or any(abs(a-b) > scale[i//2] for i,(a,b) in enumerate(zip(bounds,other)))):
        raise ValueError("同名 COPC 与原始 LAS 不匹配，请检查同目录文件。")


def convert(source, destination):
    if destination.exists():
        raise FileExistsError(f"输出文件已存在：{destination}")
    root = Path(__file__).resolve().parents[1]
    config = json.loads((root / "config/local.json").read_text(encoding="utf-8"))
    pdal = Path(config.get("copc_pdal_path") or root / ".tools/copc/Library/bin/pdal.exe")
    if not pdal.is_file():
        raise RuntimeError("本地 COPC 运行时未就绪，请执行 pnpm run setup:local。")
    env = os.environ.copy()
    env["PATH"] = str(pdal.parent) + os.pathsep + env.get("PATH", "")
    share = Path(pdal).resolve().parents[1] / "share" / "proj"
    if (share / "proj.db").is_file():
        env["PROJ_DATA"] = str(share)
    with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
        output = Path(temp, "output.copc.laz")
        alias = Path(temp, "input.las")
        try:
            os.link(source, alias)
        except OSError:
            shutil.copyfile(source, alias)
        reader = {"type": "readers.las", "filename": alias.name}
        wkt = source_wkt(source)
        if wkt:
            reader["default_srs"] = wkt
        pipeline = [reader,
                    {"type": "writers.copc", "filename": output.name, "forward": "all", "extra_dims": "all"}]
        result = subprocess.run([str(pdal), "pipeline", "--stdin"], input=json.dumps(pipeline).encode(),
                                cwd=temp, env=env, capture_output=True, creationflags=0x08000000 if os.name == "nt" else 0)
        if result.returncode:
            raise RuntimeError("PDAL 转换失败：" + result.stderr.decode(errors="replace").strip()[-500:])
        validate_companion(source, output)
        # Publish only complete output and never overwrite an existing file.
        if os.name == "nt":
            output.rename(destination)
        else:
            os.link(output, destination)


if __name__ == "__main__":
    if len(sys.argv) > 1:
        path = Path(sys.argv[1]).resolve()
        convert(path, Path(sys.argv[2]) if len(sys.argv) > 2 else path.with_suffix(".copc.laz"))
    else:
        from tkinter import Tk, filedialog, messagebox
        window = Tk()
        window.withdraw()
        source = filedialog.askopenfilename(title="选择原始点云", filetypes=[("LAS / LAZ", "*.las *.laz")])
        if source:
            destination = Path(source).with_suffix(".copc.laz")
            try:
                convert(Path(source), destination)
                messagebox.showinfo("转换完成", str(destination))
            except Exception as error:
                messagebox.showerror("转换失败", str(error))
