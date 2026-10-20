"""Read-only verification of an exact Sites origin. Secret input stays hidden."""
import json,sys,termios,urllib.request,urllib.parse
fd=sys.stdin.fileno();old=termios.tcgetattr(fd);new=termios.tcgetattr(fd);new[3]&=~termios.ECHO
termios.tcsetattr(fd,termios.TCSANOW,new)
try:
    print('Ready for hosted verification JSON on stdin (input is hidden).',flush=True)
    data=json.loads(sys.stdin.readline())
finally:termios.tcsetattr(fd,termios.TCSANOW,old)
origin=data['origin'].rstrip('/')
if not origin.startswith('https://') or urllib.parse.urlparse(origin).hostname!=data['expectedHost']:raise RuntimeError('Unexpected Site origin')
def read(path):
    req=urllib.request.Request(origin+path,headers={'OAI-Sites-Authorization':'Bearer '+data['serviceToken']})
    with urllib.request.urlopen(req,timeout=25) as res:
        return res.status,res.read().decode('utf-8')
results=[]
status,html=read('/')
results.append({'check':'html','status':status,'hasTitle':'기업 법무·세무' in html})
_,raw=read('/api/status');state=json.loads(raw)
results.append({'check':'status','counts':state['counts'],'storageConfigured':state.get('storageConfigured'),'aiEnabled':state.get('aiEnabled')})
for query,expected in [('법인세법 제19조',2),('2023두45736',1),('2025다209942',1)]:
    _,raw=read('/api/search?'+urllib.parse.urlencode({'q':query}));value=json.loads(raw)
    results.append({'check':'search','q':query,'count':value['total'],'passed':value['total']==expected})
_,raw=read('/api/evidence');value=json.loads(raw)
results.append({'check':'evidence','count':value['total'],'linkExcluded':all(d.get('bodyStatus')!='link' for d in value['documents'])})
print(json.dumps({'origin':origin,'results':results},ensure_ascii=False),flush=True)
