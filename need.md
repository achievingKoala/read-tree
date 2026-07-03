我想做一个根据图书内容来给出问题的AI助手 
AI会给出几个问题 用户选择感兴趣问题在下面的输入框回答 
Ai可以给出答案 然后用户可以针对这个答案继续聊天 
你先给我做一个纯前端的demo 然后随便想几个问题 针对某一本书 

1. todo 我需要可以新建对话 然后自己输入书籍名字 你给我出题 

2. todo 需要加根据章节提问 或者是根据整书内容提问 

3. todo 返回问题按钮是否需要 

4. todo 自己添加图书之后 先添加几个假问题用于测试 
后期改成从ai接口获取真问题 

5. todo  Local storage里面选保留对话记录 

6. todo 加一个记录页面 记录每天的提交次数 
然后给用户设定一个目标 

7. todo 默认的书
包括生命不能承受之轻 
原子习惯 
毛姆的刀锋 
被讨厌的勇气

8. todo 
"当前阅读进度根据所选章节计算为 章节号 ÷ 30，并标注为“第 N 章 / 30”，替换原先完全固定的模拟百分比。"

9. todo 加上删除图书的功能 

10. todo 不只保持30日的 保持永久的 

11. todo 
用open router作为后端 ai服务的提供
js fetch 获取
要求前后端可以同时启动 

npm start

12.
launchctl setenv HTTP_PROXY http://127.0.0.1:7897
launchctl setenv HTTPS_PROXY http://127.0.0.1:7897
launchctl setenv ALL_PROXY http://127.0.0.1:7897


export http_proxy=http://127.0.0.1:7897
export https_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

env | grep -i proxy