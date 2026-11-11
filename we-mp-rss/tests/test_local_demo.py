"""Run with: python -m unittest tests.test_local_demo (no network calls)."""
import tempfile
import unittest
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from core.db import Db, wechat_url_parts
from core.models.article import Article
from core.models.user import User
from core.models.base import DATA_STATUS
from core.task import TaskScheduler


class LocalDemoTest(unittest.TestCase):
    def test_article_identity_ignores_tracking_but_preserves_item_number(self):
        a = "https://mp.weixin.qq.com/s?__biz=AA==&mid=12&idx=1&sn=sig&chksm=old#rd"
        b = "https://mp.weixin.qq.com/s?idx=1&mid=12&__biz=AA%3D%3D&sn=sig&chksm=new"
        self.assertEqual(wechat_url_parts(a), wechat_url_parts(b))
        self.assertNotEqual(wechat_url_parts(a)[1], wechat_url_parts(a.replace("idx=1", "idx=2"))[1])

    def test_changed_upstream_id_does_not_duplicate_or_restore_excluded_article(self):
        with tempfile.TemporaryDirectory() as folder, ExitStack() as cleanup:
            db = Db(User_In_Thread=False)
            db.init("sqlite:///" + str(Path(folder) / "test.db"))
            cleanup.callback(db.engine.dispose)
            db.create_tables()
            row = dict(id="old", mp_id="MP_WXS_1", title="Sample", publish_time=123,
                       status=1, item_show_type=0, content="<p>body</p>",
                       url="https://mp.weixin.qq.com/s?__biz=AA==&mid=12&idx=1&sn=a&chksm=old")
            self.assertTrue(db.add_article(row))
            second = dict(row, id="new", url=row["url"].replace("sn=a", "sn=b").replace("chksm=old", "chksm=new"))
            self.assertFalse(db.add_article(second))
            with db.get_session() as session:
                self.assertEqual(session.query(Article).count(), 1)
                session.query(Article).update({Article.status: DATA_STATUS.DELETED})
                session.commit()
            self.assertFalse(db.add_article(second))
            with db.get_session() as session:
                self.assertEqual(session.query(Article).count(), 1)
                self.assertEqual(session.query(Article).one().status, DATA_STATUS.DELETED)

    def test_daily_schedule_uses_beijing_time(self):
        schedule = TaskScheduler()
        job_id = schedule.add_cron_job(lambda: None, "0 9 * * *", job_id="daily-test")
        next_run = schedule._jobs[job_id].trigger.get_next_fire_time(
            None, datetime(2026, 11, 10, 15, tzinfo=ZoneInfo("Asia/Shanghai")))
        self.assertEqual(next_run.isoformat(), "2026-11-11T09:00:00+08:00")


if __name__ == "__main__":
    unittest.main()
