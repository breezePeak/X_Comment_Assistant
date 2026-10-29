"""只读提取账号快照；不把帖子累计浏览误写成窗口新增曝光。"""
import argparse
import json
import sqlite3
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from statistics import median

TZ = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent
METRICS = ('views', 'likes', 'replies', 'reposts', 'bookmarks')


def timestamp(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(TZ)


def review_window(today):
    start = datetime.combine(today - timedelta(days=2), time(8), TZ)
    return start, start + timedelta(days=1)


def summarize(posts):
    metrics = {}
    for key in METRICS:
        values = [p['metrics'][key] for p in posts if p['metrics'][key] is not None]
        metrics[key] = {'samples': len(values), 'sum': sum(values) if values else None,
                        'median': median(values) if values else None}
    return {'records': len(posts), 'metrics': metrics,
            'zeroReposts': sum(p['metrics']['reposts'] == 0 for p in posts),
            'repostedRecords': sum((p['metrics']['reposts'] or 0) > 0 for p in posts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--today', type=date.fromisoformat, default=datetime.now(TZ).date())
    parser.add_argument('--database', type=Path, default=ROOT.parent / 'server/data/posts.sqlite')
    parser.add_argument('--owner', default='1nhkjltx')
    args = parser.parse_args()
    start, end = review_window(args.today)
    # shortcut: 现库只有最新快照；准确08点增量需要边界快照或官方后台导出后另算。
    with sqlite3.connect(args.database.resolve().as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        posts = [json.loads(row[0]) for row in db.execute(
            'SELECT snapshot FROM own_posts WHERE owner=? ORDER BY post_id', (args.owner,))]
    cohort = [p for p in posts if start <= timestamp(p['publishedAt']) < end]
    collected = [timestamp(p['collectedAt']) for p in posts]
    result = {'owner': args.owner, 'reviewDate': str(args.today),
              'windowStart': start.isoformat(), 'windowEndExclusive': end.isoformat(),
              'latestCollection': max(collected).isoformat() if collected else None,
              'status': 'DATA_STALE' if not collected or max(collected) < end else 'COVERAGE_UNVERIFIED',
              'windowNewImpressions': None,
              'limitations': ['只含已加载并上传的记录，完整性未验证', '无主帖/回复标记',
                              '以下是累计快照，不是历史24h值或窗口新增曝光',
                              '回复指标是收到的回复，不是发出的评论；缺失不补零'],
              'allRecords': summarize(posts), 'publishedInWindow': summarize(cohort)}
    folder = ROOT / 'snapshots'
    folder.mkdir(exist_ok=True)
    path = folder / (datetime.now(TZ).strftime('%Y%m%d-%H%M%S-%f') + '.json')
    with path.open('x', encoding='utf-8') as out:
        json.dump({'review': result, 'posts': posts}, out, ensure_ascii=False, indent=2)
    print(json.dumps({'snapshot': str(path), **result}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
