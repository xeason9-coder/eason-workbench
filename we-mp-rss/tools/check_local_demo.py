"""Read-only database check; legacy public RSS is disabled in workbench mode."""
import sqlite3


def main():
    with sqlite3.connect("data/db.db") as database:
        feeds = database.execute("select id,mp_name from feeds where status=1").fetchall()
        assert feeds, "No sources configured"
        for feed_id, name in feeds:
            expected = database.execute(
                "select count(*) from articles where status=1 and mp_id=?", (feed_id,)
            ).fetchone()[0]
            print(name, "active articles:", expected)
        missing = database.execute(
            "select count(*) from articles where status=1 and (content is null or content='')"
        ).fetchone()[0]
        assert missing == 0, "Missing article bodies"
    print("Local database checks passed; authenticated retrieval is checked in the workbench")


if __name__ == "__main__":
    main()
