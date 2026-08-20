"""Submit a registration job and wait for the PLY-to-PCD matrix."""
import sys
import time
from pathlib import Path

import requests


base_url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8765"
ply_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("source/ply/point_cloud.ply")
pcd_path = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("source/pcd/GlobalMap.pcd")

with ply_path.open("rb") as ply, pcd_path.open("rb") as pcd:
    response = requests.post(
        f"{base_url}/api/v1/registrations",
        files={"ply": (ply_path.name, ply), "pcd": (pcd_path.name, pcd)},
        timeout=600,
    )
response.raise_for_status()
job = response.json()

while True:
    status_response = requests.get(f"{base_url}{job['status_url']}", timeout=10)
    status_response.raise_for_status()
    status = status_response.json()
    if status["status"] == "succeeded":
        result_response = requests.get(f"{base_url}{status['result_url']}", timeout=10)
        result_response.raise_for_status()
        result = result_response.json()
        print("PLY -> PCD:")
        for row in result["ply_to_pcd"]:
            print(" ".join(f"{value:.12f}" for value in row))
        break
    if status["status"] == "failed":
        raise RuntimeError(status.get("error", "Registration failed"))
    time.sleep(1)
