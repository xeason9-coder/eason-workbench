"""Create/reset isolated workbench accounts without exposing passwords in arguments."""

import argparse
from getpass import getpass
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from core.workbench_auth import get_user_by_username, init_auth_tables, upsert_user


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--username", required=True)
    parser.add_argument("--role", required=True, choices=("admin", "user"))
    parser.add_argument("--password-env", metavar="ENV_NAME")
    parser.add_argument("--reset-password", action="store_true")
    parser.add_argument("--claim-existing", action="store_true", help="Explicitly assign unowned legacy workbench data to this administrator")
    args = parser.parse_args()
    try:
        init_auth_tables()
        if args.claim_existing and args.role != "admin":
            raise ValueError("旧数据只能归属管理员")
        existing = get_user_by_username(args.username)
        if existing and args.claim_existing and not args.reset_password:
            if existing.role != "admin":
                raise ValueError("指定账号不是有效管理员")
            user = existing
        else:
            if args.password_env:
                password = os.environ.get(args.password_env)
                if not password:
                    raise ValueError("指定的密码环境变量不存在或为空")
            else:
                password = getpass("Password (12–72 UTF-8 bytes): ")
                if password != getpass("Confirm password: "):
                    raise ValueError("两次密码不一致")
            user = upsert_user(args.username, password, args.role, args.reset_password)
        result = {"user_id": user.id, "username": user.username, "role": user.role}
        if args.claim_existing:
            from core.workbench import migrate_workbench_owners
            result["migration"] = migrate_workbench_owners(user.id)
    except (ValueError, RuntimeError) as exc:
        parser.exit(1, f"{exc}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
