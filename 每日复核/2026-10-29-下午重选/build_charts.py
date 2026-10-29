"""Original factual charts, not generated documentary photographs."""
from pathlib import Path
from datetime import datetime
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT=Path(__file__).resolve().parent
font_manager.fontManager.addfont('C:/Windows/Fonts/msyh.ttc')
plt.rcParams.update({'font.family':'Microsoft YaHei','axes.unicode_minus':False})
INK='#182b38'; BLUE='#156b8a'; ORANGE='#d55b32'; BG='#f6f4ee'

def canvas(title,subtitle):
    fig=plt.figure(figsize=(12,8),facecolor=BG)
    fig.text(.07,.89,title,fontsize=29,color=INK,weight='bold')
    fig.text(.07,.82,subtitle,fontsize=16,color='#56616a')
    return fig

def save(fig,name,foot):
    fig.text(.07,.10,foot,fontsize=12,color='#56616a',linespacing=1.65)
    fig.savefig(ROOT/name,dpi=150,facecolor=BG)
    plt.close(fig)

fig=canvas('同样卖100欧元，收款有两种选法','宜家二手平台规则｜示例计算，不是真实订单')
ax=fig.add_axes([.08,.29,.83,.43]); ax.set_xlim(0,132); ax.set_ylim(-.6,1.6); ax.axis('off')
for y,v,label,color in [(1,100,'银行收款',BLUE),(0,115,'宜家数字退款卡',ORANGE)]:
    ax.barh(y,v,height=.38,color=color)
    ax.text(2,y,label,va='center',color='white',fontsize=21)
    ax.text(v+2,y,f'{v}€',va='center',color=INK,fontsize=28,weight='bold')
fig.text(.08,.24,'多出的15欧元，是宜家卡余额，不是现金。',fontsize=20,color=INK)
save(fig,'01-secondhand.png','资料图：按公开规则原创整理｜适用市场见原文，不代表中国已上线\n来源：Ingka Group，2026-10-07；ingka.com/newsroom')
assert round(100*1.15,2)==115

fig=canvas('收纳调查里，出现了“前任”','26%受访者称藏有过去恋情的纪念品')
ax=fig.add_axes([.08,.28,.51,.45]); ax.set_xlim(-.7,9.7); ax.set_ylim(-.7,9.7); ax.axis('off')
for i in range(100):
    ax.scatter(i%10,9-i//10,s=250,color=ORANGE if i<26 else '#d7dbd9',marker='s')
fig.text(.65,.58,'26%',fontsize=65,color=ORANGE,weight='bold')
fig.text(.65,.43,'31个市场\n31,488名受访者',fontsize=21,color=INK,linespacing=1.7)
save(fig,'02-mementos.png','资料图：按品牌委托调查原创整理，不是中国情侣专属统计\n来源：IKEA / YouGov，2026-04调查、2026-08-24发布；ingka.com')

fig=canvas('AI伴侣App，会影响真人择偶吗？','表示不愿与AI伴侣App使用者约会的受访者比例')
ax=fig.add_axes([.08,.29,.83,.43]); ax.set_xlim(0,105); ax.set_ylim(-.6,1.6); ax.axis('off')
for y,v,label,col in [(1,40,'18–39岁单身受访者',BLUE),(0,51,'18–24岁女性受访者',ORANGE)]:
    ax.barh(y,100,height=.35,color='#dedfda'); ax.barh(y,v,height=.35,color=col)
    ax.text(0,y+.27,label,fontsize=17,color=INK)
    ax.text(v+2,y,f'{v}%',fontsize=26,color=INK,va='center',weight='bold')
save(fig,'03-ai-companion.png','资料图：美国约1,000名18–39岁单身者调查；女性子样本量未列明\n不同年龄与性别分组，不可直接当作男女差距。来源：Match Group，2026-06-18')

start=datetime.fromisoformat('2026-10-26T19:07:00+08:00')
end=datetime.fromisoformat('2026-10-29T02:52:00+08:00')
hours=(end-start).total_seconds()/3600
assert hours==55.75
fig=canvas('查不到日程，也可能是连接器故障','Claude官方已确认：Google Calendar连接器部分请求失败')
fig.text(.08,.58,'55小时45分',fontsize=56,color=ORANGE,weight='bold')
ax=fig.add_axes([.1,.34,.78,.12]); ax.set_xlim(0,1); ax.set_ylim(0,1); ax.axis('off')
ax.plot([.04,.96],[.6,.6],color=ORANGE,lw=9,solid_capstyle='round')
for x in [.04,.96]: ax.scatter(x,.6,s=150,color=INK,zorder=3)
fig.text(.08,.29,'10月26日 19:07',fontsize=20,color=INK)
fig.text(.63,.29,'10月29日 02:52',fontsize=20,color=INK)
fig.text(.08,.22,'北京时间｜影响已结束，不表示Claude整体停机',fontsize=16,color=INK)
save(fig,'04-calendar.png','资料图：按官方事件记录换算时间，并非服务监测截图\n来源：anthropic.statuspage.io/incidents/phg1y2yh07n2；2026-10-29核对')
print('4 original factual charts created')
