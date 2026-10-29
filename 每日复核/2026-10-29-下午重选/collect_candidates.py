"""One-off evidence collection: discovery links are not verified article facts."""
import json, re, urllib.request, urllib.parse, pathlib, datetime
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

ROOT = pathlib.Path(__file__).resolve().parent

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.href=None; self.parts=[]; self.links=[]
    def handle_starttag(self, tag, attrs):
        if tag == 'a': self.href=dict(attrs).get('href'); self.parts=[]
    def handle_data(self, data):
        if self.href: self.parts.append(data)
    def handle_endtag(self, tag):
        if tag == 'a' and self.href:
            self.links.append((self.href, re.sub(r'\s+', ' ', ' '.join(self.parts)).strip()))
            self.href=None

pages=['https://www.ingka.com/newsroom/latest-news/',
       'https://www.ingka.com/newsroom/ikea-to-test-direct-offers-to-sellers-through-its-second-hand-marketplace-as-the-platform-expands-to-the-uk-and-ireland/',
       'https://www.lego.com/en-us/aboutus/newsroom/press-releases',
       'https://mtch.com/news/', 'https://www.anthropic.com/news']
found={}
for i,url in enumerate(pages):
    request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'})
    try:
        raw=urllib.request.urlopen(request,timeout=30).read().decode('utf-8')
        (ROOT/f'discovery-{i}.html').write_text(raw,encoding='utf-8')
        parser=Links(); parser.feed(raw)
        for href,title in parser.links:
            link=urllib.parse.urljoin(url,href).split('#')[0]
            path=urllib.parse.urlparse(link).path
            if len(title)<18: continue
            valid=(link.startswith('https://www.ingka.com/newsroom/') and path.count('-')>=3
                   or 'lego.com/' in link and re.search(r'/aboutus/news/20\d\d/',path)
                   or link.startswith('https://mtch.com/news/') and len(path.strip('/').split('/'))==2
                   or link.startswith('https://www.anthropic.com/news/') and len(path)>15)
            if valid and link not in found:
                found[link]={'source':link,'title':title,'discoveredVia':url,'status':'index_discovery_only_not_fact_checked'}
    except Exception as exc: print(url,type(exc).__name__,str(exc))
feed=ET.parse(ROOT/'claude-history.rss')
for item in feed.findall('./channel/item'):
    link=item.findtext('link')
    if link not in found: found[link]={'source':link,'title':item.findtext('title'),'published':item.findtext('pubDate'),'discoveredVia':'https://anthropic.statuspage.io/history.rss','status':'feed_discovery_only_not_fact_checked'}
pool=list(found.values())[:50]
assert len(pool)==50, f'Only {len(pool)} real discovery links; do not claim 50.'
for i,p in enumerate(pool,1): p['id']=f'A{i:02}'
out={'collectedAt':datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),'scope':'50 primary-source discovery leads; verification and selection are separate','candidates':pool}
(ROOT/'50条一手来源线索.json').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
for p in pool: print(p['id'],p['title'][:105])
