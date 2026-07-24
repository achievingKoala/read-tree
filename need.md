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


nvm use 22.23.1
node -v
npm start

12.
launchctl setenv HTTP_PROXY http://127.0.0.1:7897
launchctl setenv HTTPS_PROXY http://127.0.0.1:7897
launchctl setenv ALL_PROXY http://127.0.0.1:7897


export http_proxy=http://127.0.0.1:7897
export https_proxy=http://127.0.0.1:7897
export all_proxy=socks5://127.0.0.1:7897

env | grep -i proxy

13. 
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export NO_PROXY=localhost,127.0.0.1
export NODE_USE_ENV_PROXY=1

14. todo 和微信读书联动 

15. todo 你在按章节出题的时候 就要把章节名字带出来 给读者校对 和避免幻觉  

16. done 你就要加上日志 记录下请求时长 看一下请求时长 

17. todo 要根据书架里的书 还推荐读什么书 
todo 你答题记录来推荐读什么书 

18. done 现在同一章节不能追加更多问题 需要改进 

19. ddone 允许自定义章节名 

20. todo 我需要去重新回答某些问题 
我需要有的时候重新去新建一个分支 
去继续讨论这个问题 
或者重新讨论 

21. done 加一个笔记本功能 对话可以存入笔记本 

22. done 调整网页内容器高度 使其和屏幕对齐 

23. todo  针对特定内容出题 

24. todo 我有一个问题 在深度过程 我如果定时了的话 那定时结束的时候 我要立刻结束这个任务 还是要再多学一会儿呢 

25. todo  你章节生成的时间应该有一个应该应该在你加入书书架时候就生成了个章节 

26. todo  要加一个主动提问功能 

27. todo 有的时候生成的章节是错误的 

28. done  question要带上chapter简介 

29. 帮我找一下市面上有没有同类型的产品 

30. 笔记本的管理能力拓展 
第一版不支持编辑备注、标签、导出或批量删除。
笔记保存的是收录时快照，不跟随原消息更新。
笔记保存的是收录时快照，不跟随原消息更新。
To pick up a draggable item, press the space bar.
While dragging, use the arrow keys to move the item.
Press space again to drop the item in its new position, or press escape to cancel.


31. done 教主读了什么书 

32. done 给我的网站加一个图标  

33. todo 一个问题毕竟还是缺乏标准 如何让用户能够不断的回来去讨论这个问题 深入讨论这个问题 或者说不断的去用这个网站呢 

34. todo 加上对话的时间戳 让对话不止可以通过以书来为单位来展示 也可以通过按时间为单位来展示 

35. 改成一个对话框 输入书名和作者之后 你立刻生按章节生成答案 
内容不要按章节划分 按生成批次划分 
之前 内容都算进一个批次   

36. todo 当存在一本书的话 要加一个按钮 可以在书里面追加问题 

37. 再生成一批时 我要可以选章节生成 
第1次生成时 我要返回章节加问题   多加几个问题 

38. todo 笔记本中放的内容 要加上章节  

39. todo 要批次和章节绑定 

40. todo 加一个ai推荐已有问题 

41. done 
加一个修改图书作者的功能 

42. todo 初始化时获取书的英文名 

43. todo 加一个基于书籍和章节提问功能 

44. done 这三个问题可以分成读前问题和读后问题 加上一个背景问题 

45. todo 做一个图书编辑框 可以编辑图书里面的作者  还有章节 
 todo Ai生成 图书简介

46. todo 问题不能一直问 需要有一个结束 

47. todo 答案中可以包括一些提示 但是不要给的太直接

48. todo 每轮对话最好只针对这个问题进行细化 不要 一直提出新问题  

49. todo 不要章节摘要 

50. todo 序言 前言

51. done 如果没回答完这个问题的话 就要继续追问 如果回答完的话就不用追问了 

52. todo 如果用户完整的回答了完一个问题之后 希望有一个记录 

53. done update chapter