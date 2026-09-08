"""Run against a local API and real Worker; writes only under runtime/business-verification.

Usage: .venv/Scripts/python.exe tests/service/business_transform_e2e.py http://127.0.0.1:8766 [--real]
"""
import http.client
import json
from pathlib import Path
import random
import sys
import time
from urllib.parse import urlsplit
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from service import app as service

base = urlsplit(sys.argv[1])
output = ROOT / "runtime" / "business-verification"
output.mkdir(parents=True, exist_ok=True)


def request(method, path, data=None):
    connection = http.client.HTTPConnection(base.hostname, base.port, timeout=60)
    body = None if data is None else json.dumps(data)
    connection.request(method, path, body, {"Content-Type": "application/json"})
    response = connection.getresponse()
    payload = response.read().decode()
    connection.close()
    assert response.status < 300, (response.status, payload)
    return json.loads(payload)


def upload(paths, fields):
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in fields.items():
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode(), None))
    for model, path in zip(("model_a", "model_b"), paths):
        parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{model}"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode(), path))
    ending = f'--{boundary}--\r\n'.encode()
    length = sum(len(header) + (path.stat().st_size + 2 if path else 0) for header, path in parts) + len(ending)
    connection = http.client.HTTPConnection(base.hostname, base.port, timeout=180)
    connection.putrequest("POST", "/api/v2/registration-sessions")
    connection.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
    connection.putheader("Content-Length", str(length))
    connection.endheaders()
    for header, path in parts:
        connection.send(header)
        if path:
            with path.open("rb") as source:
                while chunk := source.read(1024*1024):
                    connection.send(chunk)
            connection.send(b"\r\n")
    connection.send(ending)
    response = connection.getresponse()
    payload = response.read().decode()
    connection.close()
    assert response.status < 300, payload
    return json.loads(payload)


def wait(path, success):
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        value = request("GET", path)
        assert value["status"] not in ("failed", "cancelled"), value
        if value["status"] == success:
            return value
        time.sleep(1)
    raise AssertionError(f"Timed out: {path}")


def close(a, b, tolerance=1e-8):
    assert max(abs(x-y) for row_a, row_b in zip(a,b) for x,y in zip(row_a,row_b)) < tolerance


def transform_point(matrix, point):
    return [sum(matrix[row][column] * point[column] for column in range(3)) + matrix[row][3] for row in range(3)]


identity_parameters = {"translation": [0,0,0], "rotation_degrees": [0,0,0], "scale": [1,1,1]}
pa = {"translation": [2,3,4], "rotation_degrees": [-90,20,15], "scale": [1,2,3]}
pb = identity_parameters
identity = service._transform_matrix(identity_parameters)
pa_matrix = service._transform_matrix(pa)
pb_matrix = service._transform_matrix(pb)

if "--real" in sys.argv:
    paths = [ROOT / "source/ply/point_cloud.ply", ROOT / "source/pcd/GlobalMap.pcd"]
    roles = ["b"]
else:
    rng = random.Random(42)
    points_a = [(rng.uniform(-4,4), rng.uniform(-2,2), rng.uniform(-1,1)) for _ in range(1000)]
    points_b = [transform_point(pa_matrix, point) for point in points_a]
    paths = [output / "synthetic-a.pcd", output / "synthetic-b.pcd"]
    for path, points in zip(paths, (points_a, points_b)):
        path.write_text("VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1000\nHEIGHT 1\nPOINTS 1000\nDATA ascii\n" + "\n".join(" ".join(map(str,p)) for p in points), encoding="ascii")
    roles = ["a", "b"]

workspace = str(uuid.uuid4())
created = upload(paths, {"workspace_id": workspace, "moving_model": roles[0]})
session_id = created["session_id"]
session_path = f"/api/v2/registration-sessions/{session_id}"
session = wait(session_path, "ready")
assert session["business_transforms"] == {"a": identity_parameters, "b": identity_parameters}
request("PUT", session_path + "/business-transforms", {"model_a": pa, "model_b": pb})
results = []
for role in roles:
    created_job = request("POST", session_path + "/register", {
        "initial_moving_local_to_fixed_local": identity,
        "moving_model": role,
        "output_direction": "a_to_b" if role == "a" else "b_to_a",
        "coordinate_space": "business",
    })
    job = wait(created_job["status_url"], "succeeded")
    result = request("GET", job["result_url"])
    assert result["coordinate_space"] == "business"
    close(result["file_a_to_b"], service._matmul(service._inverse_affine(pb_matrix), service._matmul(result["a_to_b"], pa_matrix)))
    close(service._matmul(result["a_to_b"], result["b_to_a"]), identity)
    assert result["recommended_matrix"]["value"] == result["a_to_b" if role == "a" else "b_to_a"]
    if "--real" not in sys.argv:
        close(result["a_to_b"], identity, 2e-5)
        close(result["file_a_to_b"], pa_matrix, 2e-5)
        assert result["metrics"]["final_rms"] < 2e-5, result["metrics"]
        for point_a, point_b in zip(points_a[:10], points_b[:10]):
            close([transform_point(result["a_to_b"], transform_point(pa_matrix, point_a))], [transform_point(pb_matrix, point_b)], 2e-5)
    for name in ("a_to_b", "b_to_a", "file_a_to_b", "file_b_to_a"):
        connection = http.client.HTTPConnection(base.hostname, base.port, timeout=10)
        connection.request("GET", f'/api/v1/registrations/{created_job["job_id"]}/files/{name}_matrix.txt')
        response = connection.getresponse()
        matrix = [[float(value) for value in row.split()] for row in response.read().decode().splitlines()]
        connection.close()
        assert response.status == 200
        close(matrix, result[name])
    archived = request("GET", f"/api/v2/registration-history/{session_id}?workspace_id={workspace}")
    close(archived["a_to_b"], result["a_to_b"])
    results.append(result)
    print(f'PASS role={role} coordinate_space=business rms={result["metrics"]["final_rms"]}', flush=True)

summary = {"session_id": session_id, "workspace_id": workspace, "url": sys.argv[1]+f"/?session={session_id}&api=v2", "runs": len(results)}
(output / ("real-summary.json" if "--real" in sys.argv else "synthetic-summary.json")).write_text(json.dumps(summary), encoding="utf-8")
print(json.dumps(summary), flush=True)
