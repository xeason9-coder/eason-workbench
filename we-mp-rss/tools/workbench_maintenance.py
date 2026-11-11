"""Backup the local pilot without copying its database while it is being written."""
import argparse
import hashlib
import json
import shutil
import sqlite3
import subprocess
import tempfile
import urllib.request
from datetime import datetime
from contextlib import closing
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]


def copy_database(source, destination):
    with closing(sqlite3.connect(str(source))) as src, closing(sqlite3.connect(str(destination))) as dst:
        src.backup(dst)
        result = dst.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError("Database integrity check failed")


def backup(root=ROOT):
    database = root / "data/db.db"
    if not database.is_file():
        raise RuntimeError("Database not found; no empty backup was created")
    stamp = datetime.now(ZoneInfo("Asia/Shanghai")).strftime("%Y%m%d-%H%M%S")
    target = root / "data/backups" / (stamp + "-" + uuid4().hex[:6])
    target.mkdir(parents=True, mode=0o700)
    copy_database(database, target / "db.db")
    for relative in ["config.yaml", "data/workbench-settings.json", "data/wx.lic", "data/local-access.json"]:
        source = root / relative
        if source.is_file():
            dest = target / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
    revision = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True,
                              text=True, check=False).stdout.strip()
    files = {p.relative_to(target).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
             for p in target.rglob("*") if p.is_file()}
    (target / "manifest.json").write_text(json.dumps({
        "created_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
        "base_revision": revision, "files_sha256": files,
        "private": True, "note": "Includes credentials; keep private. Uncommitted code is not included.",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return target


def check():
    with urllib.request.urlopen("http://127.0.0.1:8768/workbench/healthz", timeout=15) as response:
        state = json.load(response)
    print(json.dumps({
        "version": state["version"],
        "status": state["status"],
        "note": "健康检查不读取客户数据；请登录工作台检查文章与采集结果。",
    }, ensure_ascii=False, indent=2))


def self_check():
    with tempfile.TemporaryDirectory() as folder:
        source, saved, restored = [Path(folder) / name for name in ("source.db", "saved.db", "restored.db")]
        copy_database_sample = sqlite3.connect(source)
        copy_database_sample.execute("CREATE TABLE sample (value TEXT)")
        copy_database_sample.execute("INSERT INTO sample VALUES ('kept')")
        copy_database_sample.commit()
        copy_database_sample.close()
        copy_database(source, saved)
        copy_database(saved, restored)
        db = sqlite3.connect(restored)
        try:
            assert db.execute("SELECT value FROM sample").fetchall() == [("kept",)]
        finally:
            db.close()
    print("Backup and restore self-check passed (temporary data only)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["backup", "check", "self-check"])
    command = parser.parse_args().command
    if command == "backup":
        print("Private backup saved: " + str(backup()))
    elif command == "check":
        check()
    else:
        self_check()
