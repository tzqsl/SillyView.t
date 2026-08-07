# SillyView 角色任务模板

用途：作为角色卡世界书中的 `sv_memo_tasks` 条目内容，为福贺久留美、小金萌智子、山师芽吹、高根康子、山吹纱夜提供角色主线、好感度剧情和日常支线。

使用要求：安装并启用 ST-Prompt-Template。将下方代码块内部的完整内容粘贴到角色卡主世界书或附加世界书中名为 `sv_memo_tasks` 的条目。不要把 Markdown 代码围栏一并粘贴。

## 设计约定

- `main`：顶层主线。每名角色的心理创伤成长线都是三阶段系列任务，分别在好感度 30、60、85 解锁。
- `character`：角色任务顶层；通过 `character_group` 按角色折叠，再通过 `task_subcategory` 区分 `main`、`affection`、`side`。
- `side`：通用支线，帮助玩家熟悉交易、资产、风控和债务机制。
- 文档内部使用 `character_main`、`affection`、`character_side` 作为易读标记，模板输出前会自动映射为手机页面需要的字段。
- 主线条件中的 `label` 明确写出目标值；手机任务页还会显示当前值及离目标的差距。
- 所有 `complete_prompt` 都是待扩写的故事梗概，包含场景、冲突、角色反应和剧情落点，不使用“角色做了某事”式空泛指令。
- 好感度不足时系列任务的 `steps` 为空，插件将其显示为锁定；达到门槛后会按阶段逐步追加步骤，并保留已完成进度。
- 好感度二、三阶段还分别要求完成一条角色前置支线。两条前置支线在相邻阶段门槛的均值并四舍五入，即好感度 45 与 73 时解锁。
- `prerequisite_task_ids` 填写前置任务 ID；`unlock_affection` 和 `unlock_affection_current` 共同提供角色支线的好感度解锁判定与当前进度。

## 世界书条目：sv_memo_tasks

```ejs
<%
const affection = {
  kurumi: Number(getvar('stat_data.好感度.福贺久留美', { defaults: 0 })) || 0,
  mochiko: Number(getvar('stat_data.好感度.小金萌智子', { defaults: 0 })) || 0,
  mebuki: Number(getvar('stat_data.好感度.山师芽吹', { defaults: 0 })) || 0,
  yasuko: Number(getvar('stat_data.好感度.高根康子', { defaults: 0 })) || 0,
  saya: Number(getvar('stat_data.好感度.山吹纱夜', { defaults: 0 })) || 0
};

const unlockedSteps = (score, definitions) => definitions.filter((_, index) => score >= [30, 60, 85][index]);
const currentText = (score, texts) => score < 30
  ? '好感度达到 30 后解锁第一阶段。'
  : score < 60 ? texts[0]
  : score < 85 ? texts[1]
  : texts[2];
const condition = (type, operator, value, label) => ({ type, operator, value, label });

const tasks = [
  {
    id: 'kurumi_main', type: 'series', name: '久留美主线·复仇之外',
    task_category: 'character_main', character_group: '福贺久留美',
    content: currentText(affection.kurumi, [
      '第一阶段：陪久留美证明交易不必依靠孤注一掷。目标为累计完成 3 笔交易；任务页会显示当前次数以及还差几笔。',
      '第二阶段：在她谈及母亲与两千万债务后，用可验证的盈利替代豪赌冲动。目标为累计盈利 300000；任务页会显示当前盈利以及距目标还差多少。',
      '第三阶段：陪她建立不以复仇定义人生的长期安全感。目标为账户净值达到 20000000；任务页会显示当前净值以及距目标还差多少。'
    ]),
    steps: unlockedSteps(affection.kurumi, [
      { id: 'kurumi_main_30', name: '可控的第一步', conditions: [condition('trade_count', 'gte', 3, '累计交易 3 笔')], complete_prompt: '扩写一段久留美与用户复盘三笔交易的剧情：她起初兴奋地想追逐更高杠杆，用户没有替她决策，而是请她亲自说明每笔交易的依据与退出点。她在守住“盈亏自负”边界的同时，第一次承认有人陪她检查风险让她感到安心；结尾由她认真约定，下次冲动前会先把理由说给用户听。' },
      { id: 'kurumi_main_60', name: '红绿线后的旧伤', conditions: [condition('profit', 'gte', 300000, '累计盈利 300000')], complete_prompt: '扩写一段深夜行情结束后的交心剧情：累计盈利达到三十万成为契机，久留美却没有庆祝，反而终于讲出母亲、金融风暴与两千万债务的真相。用户不把盈利当作替她复仇的承诺，而是指出她无需用自己的毁灭偿还母亲的人生。久留美从防备、短暂猜疑到失声落泪，最后允许用户留下陪她看完天亮。' },
      { id: 'kurumi_main_85', name: '不再只为复仇活着', conditions: [condition('net_worth', 'gte', 20000000, '账户净值 20000000')], complete_prompt: '扩写久留美主线终章：账户净值达到两千万后，她面对象征复仇终点的数字却感到空洞，并险些再次用高杠杆证明自己。用户陪她把母亲的遗物、债务记录和这些年的模拟交易整理起来，让她看见自己早已不是十二岁的孩子。她最终决定保留必要资金、停止自毁式追逐，并第一次谈起毕业、旅行和与用户共同生活的未来；结尾是她把“替妈妈赢回来”改成“为自己好好活下去”。' }
    ])
  },
  {
    id: 'kurumi_affection', type: 'series', name: '久留美好感·认真约定',
    task_category: 'affection', character_group: '福贺久留美',
    content: currentText(affection.kurumi, ['第一阶段：一场自然亲近的校园约会。', '第二阶段：在脆弱被看见后建立身体与情绪上的信任。', '第三阶段：确认彼此会共同面对未来，而非以金钱衡量关系。']),
    steps: unlockedSteps(affection.kurumi, [
      { id: 'kurumi_affection_30', name: '放学后的甜点约定', complete_prompt: '扩写一段轻快的校园约会：久留美履行先前随口记下的约定，拉用户去吃她用小额盈利请客的甜点。她诚实承认选店时紧张了很久，两人在散步和互相尝甜点的细节中逐渐靠近；结尾她红着脸预约下一次见面，并强调这不是投资回报，而是她真心想和用户待在一起。' },
      { id: 'kurumi_affection_60', name: '把脆弱交给你', prerequisite_task_ids: ['kurumi_side_cooking'], complete_prompt: '扩写一段雨夜相伴剧情：行情波动勾起久留美的旧伤，她努力维持平常的活泼，最终在用户面前卸下伪装。用户尊重她的边界，只在得到允许后握住她的手、替她擦去眼泪。她靠在用户肩上承认自己害怕被看不起，并在得到坚定回应后主动抱紧用户，把这次拥抱当成只属于两人的秘密。' },
      { id: 'kurumi_affection_85', name: '比数字更长久的约定', prerequisite_task_ids: ['kurumi_side_boundary'], complete_prompt: '扩写一段关系确认剧情：久留美准备了一份没有价格曲线、只记录两人共同回忆的手账，在安静的夜晚交给用户。她坦白自己害怕失去，也不再用盈利证明值得被爱；两人以相拥、额头相抵和郑重承诺确认亲密关系。结尾由她孩子气地索要一个长久的拥抱，并约定今后的输赢都不隐瞒、不独自承担。' }
    ])
  },
  {
    id: 'mochiko_main', type: 'series', name: '萌智子主线·完美面具',
    task_category: 'character_main', character_group: '小金萌智子',
    content: currentText(affection.mochiko, [
      '第一阶段：用稳定积累回应萌智子的观察。目标为总资产达到 500000；任务页会显示当前值与差距。',
      '第二阶段：在不借债的前提下证明自制。目标为负债等于 0 且累计交易达到 8 笔；任务页会逐项显示当前值。',
      '第三阶段：让她相信亲密不是观赏他人坠落。目标为账户净值达到 10000000；任务页会显示当前净值与差距。'
    ]),
    steps: unlockedSteps(affection.mochiko, [
      { id: 'mochiko_main_30', name: '不入局的观察者', conditions: [condition('total_assets', 'gte', 500000, '总资产 500000')], complete_prompt: '扩写萌智子第一次认真审视用户的剧情：用户以五十万总资产的稳步积累回应她若有若无的诱导，没有追逐一夜暴富。萌智子维持优雅笑容，以专业问题层层试探，却发现用户愿意承认无知和风险。结尾她第一次放弃把用户当作有趣的观察样本，邀请用户以平等身份共饮一杯咖啡。' },
      { id: 'mochiko_main_60', name: '拒绝坠落的诱惑', conditions: [condition('debt', 'eq', 0, '负债保持为 0'), condition('trade_count', 'gte', 8, '累计交易 8 笔')], complete_prompt: '扩写一段萌智子精心设置考验却被反过来看穿的剧情：用户完成八笔交易且没有负债，拒绝她包装得无比合理的危险机会，并温和指出她似乎总在等待别人失控。她先以成熟措辞否认，继而因用户没有厌恶或揭穿她而动摇，首次谈及校园欺凌、冷漠父母与奶奶离世。结尾不是原谅宣言，而是用户留下陪她沉默，让她第一次体验无需表演完美也不会被抛下。' },
      { id: 'mochiko_main_85', name: '剧场落幕之后', conditions: [condition('net_worth', 'gte', 10000000, '账户净值 10000000')], complete_prompt: '扩写萌智子主线终章：用户净值达到一千万后，她准备了最后一次足以诱发贪婪的试探，却在真正可能伤害用户前主动终止。她承认自己从他人的绝望中获得安全感，因为那让她确信痛苦并非只属于自己。用户没有美化她的行为，而是要求她为选择负责并学习真诚关心。萌智子摘下完美面具，哭着承认害怕被看见真实一面；结尾她选择坦白一项过去的欺骗，并请求从真实的朋友与爱人开始。' }
    ])
  },
  {
    id: 'mochiko_affection', type: 'series', name: '萌智子好感·偏爱失控',
    task_category: 'affection', character_group: '小金萌智子',
    content: currentText(affection.mochiko, ['第一阶段：优雅前辈对用户产生私人兴趣。', '第二阶段：克制的照顾逐渐越过普通朋友。', '第三阶段：她只向用户承认依赖与独占欲。']),
    steps: unlockedSteps(affection.mochiko, [
      { id: 'mochiko_affection_30', name: '藏起来的可爱偏好', complete_prompt: '扩写一段商店偶遇剧情：用户撞见萌智子对可爱饰品毫无抵抗力，她立刻恢复优雅并嘴硬否认。用户没有取笑，而是陪她挑选一个低调的小挂件。回程中她把同款另一只送给用户，表面说是礼节，细节却显露她期待两人拥有成对物件的私心。' },
      { id: 'mochiko_affection_60', name: '只为你破例', prerequisite_task_ids: ['mochiko_side_cute'], complete_prompt: '扩写一段用户疲惫生病时的照顾剧情：萌智子以不容拒绝的从容接管晚餐、药物和休息安排，嘴上称只是顺路，实际守到深夜。用户醒来发现她靠在床边睡着，握住她的手后，她短暂慌乱却没有抽开。结尾她允许用户靠在自己肩上，低声承认这种麻烦只愿意为用户承担。' },
      { id: 'mochiko_affection_85', name: '面具只对你摘下', prerequisite_task_ids: ['mochiko_side_review'], complete_prompt: '扩写一段私密而克制的告白：萌智子带用户去奶奶曾经照顾她的旧居，坦白自己对亲密、嫉妒和失去的恐惧。她不再使用大姐姐式的完美措辞，而是笨拙地询问用户能否接受不体面的自己。两人在长久拥抱与轻柔亲吻中确认关系；结尾她仍故作镇定地整理衣领，却把用户的手紧紧扣在掌心。' }
    ])
  },
  {
    id: 'mebuki_main', type: 'series', name: '芽吹主线·暴富梦醒',
    task_category: 'character_main', character_group: '山师芽吹',
    content: currentText(affection.mebuki, [
      '第一阶段：让芽吹理解交易不是必胜游戏。目标为累计完成 5 笔交易；任务页会显示当前次数与差距。',
      '第二阶段：用可控仓位对抗死扛冲动。目标为最大持仓金额达到 300000 且累计成交额达到 1000000；任务页会逐项显示差距。',
      '第三阶段：证明踏实积累也能带来自由。目标为累计盈利达到 400000 且负债等于 0；任务页会逐项显示当前值。'
    ]),
    steps: unlockedSteps(affection.mebuki, [
      { id: 'mebuki_main_30', name: '没有必胜代码', conditions: [condition('trade_count', 'gte', 5, '累计交易 5 笔')], complete_prompt: '扩写芽吹跟着用户复盘五笔交易的剧情：她不断追问必胜代码，试图把偶然盈利归功于天赋。用户让她亲手记录每次入场理由、手续费和退出结果，她从不耐烦到发现自己的判断多半来自跟风。结尾她仍用轻快语气抱怨麻烦，却郑重答应下一次至少先看完记录再下单。' },
      { id: 'mebuki_main_60', name: '死扛之前停下来', conditions: [condition('max_position_amount', 'gte', 300000, '最大持仓金额 300000'), condition('total_trade_amount', 'gte', 1000000, '累计成交额 1000000')], complete_prompt: '扩写一次高压行情中的冲突：累计成交额达到一百万后，芽吹面对三十万规模仓位的逆势波动，恐慌地想借钱加仓。用户没有替她填补亏损，而是守在旁边要求她正视风险和退出选择。她经历恼怒、撒娇、崩溃后终于停止借贷念头，并承认自己怕的不是亏钱，而是承认暴富幻想可能是错的。' },
      { id: 'mebuki_main_85', name: '接受普通却真实的人生', conditions: [condition('profit', 'gte', 400000, '累计盈利 400000'), condition('debt', 'eq', 0, '负债保持为 0')], complete_prompt: '扩写芽吹主线终章：累计盈利达到四十万且无负债后，她本想举办夸张庆功会，却在旧日高利贷广告前停下。她坦白曾把用户当作永远替自己收拾残局的靠山，也害怕一旦变普通就不再值得喜欢。用户肯定她守约和重新学习的努力，但拒绝纵容寄生。芽吹哭过后主动制定学习、兼职和交易限额计划；结尾她仍梦想发财，却第一次把“和用户一起踏实生活”写在暴富之前。' }
    ])
  },
  {
    id: 'mebuki_affection', type: 'series', name: '芽吹好感·黏人的真心',
    task_category: 'affection', character_group: '山师芽吹',
    content: currentText(affection.mebuki, ['第一阶段：热闹玩笑中出现只对用户的偏心。', '第二阶段：撒娇不再只是为了求助。', '第三阶段：她学会用承担责任表达爱意。']),
    steps: unlockedSteps(affection.mebuki, [
      { id: 'mebuki_affection_30', name: '不是为了秘诀的约会', complete_prompt: '扩写芽吹约用户逛街的轻喜剧：她起初假装要寻找投资灵感，实际精心挑选了适合两人一起玩的街机和小吃。她一路吵闹撒娇，却在用户问起目的时难得脸红，承认今天没有内幕、没有求带，只是想单独相处。结尾她把赢来的小挂件挂到用户包上，宣布这是下次约会的预约凭证。' },
      { id: 'mebuki_affection_60', name: '撒娇之外的依靠', prerequisite_task_ids: ['mebuki_side_job'], complete_prompt: '扩写芽吹在遭遇挫折后主动来见用户的夜晚：她习惯性地开玩笑求安慰，却在用户认真倾听时卸下轻浮语气，承认害怕失败后被嫌弃。用户没有许诺替她解决一切，而是拥抱她并肯定她愿意面对问题。她靠在用户怀里哭完后，第一次不以借钱或秘诀为条件请求用户陪她到天亮。' },
      { id: 'mebuki_affection_85', name: '我也想成为你的依靠', prerequisite_task_ids: ['mebuki_side_first_profit'], complete_prompt: '扩写芽吹准备笨拙告白的剧情：她用兼职赚来的钱安排了一顿并不昂贵却处处用心的晚餐，坦白过去总想依赖用户，现在也想成为能被依赖的人。她在紧张中恢复熟悉的活泼语气，又认真请求建立彼此平等的亲密关系。两人以拥抱和轻吻回应，结尾她把共同储蓄计划命名得夸张可爱，却坚持第一笔由自己存入。' }
    ])
  },
  {
    id: 'yasuko_main', type: 'series', name: '康子主线·风暴之后',
    task_category: 'character_main', character_group: '高根康子',
    content: currentText(affection.yasuko, [
      '第一阶段：用现金储备证明安全优先。目标为现金余额达到 200000；任务页会显示当前余额与差距。',
      '第二阶段：正视风险而非逃避数字。目标为负债等于 0 且账户净值达到 500000；任务页会逐项显示差距。',
      '第三阶段：建立市场之外的稳定未来。目标为账户净值达到 2000000；任务页会显示当前净值与差距。'
    ]),
    steps: unlockedSteps(affection.yasuko, [
      { id: 'yasuko_main_30', name: '先留下退路', conditions: [condition('cash', 'gte', 200000, '现金余额 200000')], complete_prompt: '扩写康子查看用户二十万现金储备后的剧情：她先以常识人口吻严格检查是否借贷得来，确认是保留的安全资金后才明显松口气。两人一起讨论生活开支和最坏情况，她意外谈起自己爆仓后连账单都不敢打开的日子。结尾她把一张亲手画的预算表交给用户，嘴硬说只是防止又多一个需要她操心的人。' },
      { id: 'yasuko_main_60', name: '敢于看清旧伤', conditions: [condition('debt', 'eq', 0, '负债保持为 0'), condition('net_worth', 'gte', 500000, '账户净值 500000')], complete_prompt: '扩写康子陪用户核对无负债、五十万净值账户的剧情：屏幕上的波动触发她对爆仓的恐惧，她却不再立刻逃开，而是在用户陪伴下完整讲述“小飞酱”时期的虚荣、惨败与羞耻。用户没有要求她重新证明交易能力，只肯定她退出和重建生活的勇气。结尾她删除珍藏多年的催债截图备份，把博客旧账号交给用户一起封存。' },
      { id: 'yasuko_main_85', name: '把未来画在纸上', conditions: [condition('net_worth', 'gte', 2000000, '账户净值 2000000')], complete_prompt: '扩写康子主线终章：账户净值达到两百万后，康子仍担心一切会被市场夺走。用户陪她把资金划分为生活保障、创作投入和严格受限的低风险部分，并强调净值不是她价值的证明。她终于拿出搁置已久的设计作品集，决定以真实姓名重新开始职业道路；结尾两人在工作室墙上贴出未来计划，她画下的不是K线，而是两个人平淡生活的房间。' }
    ])
  },
  {
    id: 'yasuko_affection', type: 'series', name: '康子好感·平淡未来',
    task_category: 'affection', character_group: '高根康子',
    content: currentText(affection.yasuko, ['第一阶段：从操心变成期待见面。', '第二阶段：她允许用户照顾总在照顾别人的自己。', '第三阶段：以踏实而亲密的共同生活确认关系。']),
    steps: unlockedSteps(affection.yasuko, [
      { id: 'yasuko_affection_30', name: '热拉面与回程路', complete_prompt: '扩写康子拉用户去吃热拉面的日常：她一路吐槽用户不会照顾自己，又因被误认成小学生而气得辩解。用户认真尊重她作为成年人的能力，也注意到她照顾别人后的疲惫。回程时两人自然地牵住手，她嘴上说怕用户走丢，却一直没有松开。' },
      { id: 'yasuko_affection_60', name: '今天换你休息', prerequisite_task_ids: ['yasuko_side_blog'], complete_prompt: '扩写用户照顾熬夜赶稿的康子：她最初坚持自己没事，最终在热饭和安静陪伴中放下责任感。用户替她整理工作台但不擅自碰作品，她因此感到被理解。她靠在用户肩上睡着，醒来后羞恼又舍不得离开，最后小声允许用户以后也这样管着她。' },
      { id: 'yasuko_affection_85', name: '一起过普通日子', prerequisite_task_ids: ['yasuko_side_debt_free'], complete_prompt: '扩写康子在新工作室中的告白：她展示为两人设计的生活空间草图，坦白自己想要的不是刺激或财富，而是能一起吃饭、工作、争吵后仍会回家的关系。用户郑重回应后，她含泪拥抱并主动亲吻用户；结尾两人并肩修改草图，把彼此的书桌和共同餐桌画进未来。' }
    ])
  },
  {
    id: 'saya_main', type: 'series', name: '纱夜主线·学会并肩',
    task_category: 'character_main', character_group: '山吹纱夜',
    content: currentText(affection.saya, [
      '第一阶段：建立不靠隐瞒维系的生活安全感。目标为现金余额达到 300000；任务页会显示当前余额与差距。',
      '第二阶段：共同承担治疗与未来规划。目标为总资产达到 1000000；任务页会显示当前值与差距。',
      '第三阶段：让关系从依附走向并肩。目标为账户净值达到 3000000 且负债等于 0；任务页会逐项显示差距。'
    ]),
    steps: unlockedSteps(affection.saya, [
      { id: 'saya_main_30', name: '藏在手机里的账单', conditions: [condition('cash', 'gte', 300000, '现金余额 300000')], complete_prompt: '扩写纱夜在三十万现金储备建立后被发现偷看医疗账单的剧情：她用撒娇和装傻掩饰，最终承认早已知道哥哥为治疗花光积蓄，也害怕一旦病好就不再被需要。用户不责怪她，而是明确说明隐瞒不能换来安全感。两人第一次共同核对生活与治疗预算，结尾纱夜主动说出真实恐惧，并答应以后不用装病或装笨留住哥哥。' },
      { id: 'saya_main_60', name: '不是被养着的未来', conditions: [condition('total_assets', 'gte', 1000000, '总资产 1000000')], complete_prompt: '扩写总资产达到一百万后的升学规划剧情：纱夜试图把所有志愿都偷偷改到哥哥身边，并用身体状况逃避选择。用户保证不会抛下她，却要求她挑选真正想学的方向。冲突中她承认害怕独立等于失去亲密，随后第一次展示自己认真搜集的学校资料和能力。结尾两人共同制定既照顾健康又尊重她人生的计划，她以拥抱确认距离不会取消归属。' },
      { id: 'saya_main_85', name: '留下不是因为威胁', conditions: [condition('net_worth', 'gte', 3000000, '账户净值 3000000'), condition('debt', 'eq', 0, '负债保持为 0')], complete_prompt: '扩写纱夜主线终章：净值达到三百万且无负债后，一次关于分开的误会触发她的极端恐惧，她险些用伤害自己的话挽留用户。用户坚定阻止并明确爱不能建立在威胁上，同时保证不会抛下她。纱夜在崩溃后主动交出藏起的危险物品，接受就医与长期支持，并坦白自己真正想要的是被选择而非被迫照顾。结尾她以自己的计划走出家门，又回身牵住用户的手，说这次要并肩前进。' }
    ])
  },
  {
    id: 'saya_affection', type: 'series', name: '纱夜好感·唯一的归属',
    task_category: 'affection', character_group: '山吹纱夜',
    content: currentText(affection.saya, ['第一阶段：撒娇中出现少女式悸动。', '第二阶段：亲密接触伴随真实的安全感沟通。', '第三阶段：在清晰边界和自愿选择中确认深厚关系。']),
    steps: unlockedSteps(affection.saya, [
      { id: 'saya_affection_30', name: '哥哥的旧卫衣', complete_prompt: '扩写温暖的居家日常：纱夜穿着哥哥的旧卫衣一起做蛋包饭，故意笨手笨脚制造靠近机会，却在被夸奖时露出真正羞涩。饭后她试探哥哥喜欢怎样的人，得到重视她真实想法的回答。结尾两人靠在沙发上分享耳机，她悄悄勾住哥哥手指，把普通陪伴珍藏成只有彼此懂的心动。' },
      { id: 'saya_affection_60', name: '不用装可怜的拥抱', prerequisite_task_ids: ['saya_side_game'], complete_prompt: '扩写纱夜因嫉妒闹别扭后的和解：她先用哭腔和装病试图留住哥哥，随后在对方温柔而坚定的追问下承认只是害怕被替代。哥哥没有因威胁妥协，而是主动给予拥抱并说明她可以直接请求陪伴。纱夜第一次不表演虚弱，坦率说想被抱久一点；结尾两人在安静相拥中约定嫉妒和不安都可以说出口。' },
      { id: 'saya_affection_85', name: '被选择的未来', prerequisite_task_ids: ['saya_side_reserve'], complete_prompt: '扩写一段成熟而克制的关系确认：纱夜拿出自己完成的升学与治疗计划，证明她愿意成长，却坦白成长并未减少对哥哥的深厚爱意。双方认真谈清依赖、边界、健康与未来，不以血缘身份、疾病或威胁迫使对方回应。哥哥明确选择继续陪伴，纱夜在得到同意后以长久拥抱和额头相抵回应；结尾她不再说“你跑不掉”，而是问“我们可以一起走吗”。' }
    ])
  },

  { id: 'kurumi_side_cooking', name: '久留美支线·两个人的厨房止损', task_category: 'character_side', character_group: '福贺久留美', unlock_affection: 45, unlock_affection_current: affection.kurumi, content: '好感度达到 45 后解锁。与久留美准备一顿只属于两人的晚餐，在生活里的笨拙与偏爱中拉近距离；无金融完成条件。', complete_prompt: '扩写好感度四十五时的厨房约会：久留美兴冲冲地把用户叫来试吃，明明提前练习过却假装只是顺便。料理失控后，两人贴得很近地抢救晚餐，她只允许用户从自己的筷子上尝味道，又在被指出偏心时红着脸承认希望用户常来。结尾她把写着两人名字的菜谱折好收藏，约定下一顿也只和用户一起做。' },
  { id: 'kurumi_side_boundary', name: '久留美支线·把决定交给彼此', task_category: 'character_side', character_group: '福贺久留美', unlock_affection: 73, unlock_affection_current: affection.kurumi, content: '好感度达到 73 且累计完成 2 笔交易后解锁剧情。在复盘中尊重“盈亏自负”，也让她确信亲密不等于替彼此承担人生。', conditions: [condition('trade_count', 'gte', 2, '累计交易 2 笔')], complete_prompt: '扩写好感度七十三时的深夜复盘：久留美认真分析两笔交易，却因害怕自己的意见伤害用户而数次停下。用户明确最终决定和盈亏由自己承担，同时也坦白关心她不是为了获取答案。她终于说出越亲近越怕重演母亲悲剧的恐惧，主动把额头抵在用户肩上，请用户在她想孤注一掷时提醒她。结尾两人十指相扣，约定尊重彼此选择，也不把痛苦独自藏起来。' },
  { id: 'kurumi_side_risk_diary', name: '久留美支线·五次停手练习', task_category: 'character_side', character_group: '福贺久留美', content: '累计完成 5 笔交易，与久留美整理一份包含入场、退出和冲动时刻的风险日记。', conditions: [condition('trade_count', 'gte', 5, '累计交易 5 笔')], complete_prompt: '扩写久留美陪用户整理五笔成交记录的日常：她对专业细节兴致勃勃，却在看到某次高杠杆冲动时明显紧张。两人不以输赢评判彼此，而是给每次停手的决定贴上一枚小星星。结尾久留美也在日记末页写下自己的冲动预警信号，邀请用户以后互相监督，但坚持所有交易仍由本人决定。' },

  { id: 'mochiko_side_cute', name: '萌智子支线·只与你共享的可爱', task_category: 'character_side', character_group: '小金萌智子', unlock_affection: 45, unlock_affection_current: affection.mochiko, content: '好感度达到 45 后解锁。陪萌智子挑选一件成对的小物，让她在用户面前保留不完美的可爱一面；无金融完成条件。', complete_prompt: '扩写好感度四十五时的杂货店约会：萌智子仍用优雅措辞否认喜欢毛绒摆件，却已经熟练地把用户带到最喜欢的货架。用户替她保守秘密，也坦率指出无需在自己面前维持完美。她迟疑后买下成对挂件，亲手把其中一只系在用户随身物品上；结尾她贴近耳边要求这是两人的秘密，笑容第一次不带观察和试探。' },
  { id: 'mochiko_side_review', name: '萌智子支线·不把你当作样本', task_category: 'character_side', character_group: '小金萌智子', unlock_affection: 73, unlock_affection_current: affection.mochiko, content: '好感度达到 73 且累计成交额达到 500000 后解锁剧情。接受她坦诚而有边界的复盘，并要求她停止用用户的失控验证安全感。', conditions: [condition('total_trade_amount', 'gte', 500000, '累计成交额 500000')], complete_prompt: '扩写好感度七十三时的私密复盘：萌智子逐项拆解五十万累计成交额，却在用户可能受挫处下意识等待崩溃。用户平静指出这份期待，也承认即使看见她不体面的部分仍愿意留下，但不会接受伤害性的试探。她的完美笑容短暂碎裂，主动交代一处刻意隐瞒的风险，并允许用户握住自己发冷的手。结尾她承诺今后先保护用户而非观察用户，第一次直接请求不要离开。' },
  { id: 'mochiko_side_restraint', name: '萌智子支线·留白的投资晚餐', task_category: 'character_side', character_group: '小金萌智子', content: '在负债为 0 且累计完成 6 笔交易后，与萌智子安排一次不讨论收益排名的晚餐。', conditions: [condition('debt', 'eq', 0, '负债保持为 0'), condition('trade_count', 'gte', 6, '累计交易 6 笔')], complete_prompt: '扩写无负债且完成六笔交易后的晚餐：萌智子本想用复杂问题考察用户，却发现用户主动保留安全余地。两人约定整晚不谈收益排名，转而聊奶奶留下的习惯、可爱的甜品和各自真正害怕的事。她几次想用从容笑容带过，最终还是承认平静相处比观看胜负更让她不安也更珍惜；结尾两人把手机扣在桌面，完整陪伴彼此。' },

  { id: 'mebuki_side_job', name: '芽吹支线·把约会工资赚回来', task_category: 'character_side', character_group: '山师芽吹', unlock_affection: 45, unlock_affection_current: affection.mebuki, content: '好感度达到 45 后解锁。陪芽吹体验一天兼职，她想亲手赚到下一次两人约会的费用；无金融完成条件。', complete_prompt: '扩写好感度四十五时的兼职日常：芽吹嘴上抱怨累，实际因为想亲手请用户约会而格外认真。用户不替她完成工作，只在休息时替她擦去额头汗水，她立刻脸红又用夸张玩笑遮掩。领到工资后，她没有索要秘诀或借钱，而是把第一张钞票郑重留作两人的约会基金；结尾她挽住用户手臂，宣布下次由她负责让用户开心。' },
  { id: 'mebuki_side_first_profit', name: '芽吹支线·庆祝后也不松手', task_category: 'character_side', character_group: '山师芽吹', unlock_affection: 73, unlock_affection_current: affection.mebuki, content: '好感度达到 73 且累计盈利达到 50000 后解锁剧情。陪芽吹庆祝，也一起分清运气、努力与两人关系。', conditions: [condition('profit', 'gte', 50000, '累计盈利 50000')], complete_prompt: '扩写好感度七十三时的盈利庆祝：芽吹兴奋地拉用户吃饭，却主动扣除成本并把大部分成果留下，没有借机要求更冒险的秘诀。回程中她坦白以前黏着用户既因为喜欢也因为想找永远收拾残局的人，如今更怕这种依赖会把用户推远。用户抱住她但不许诺代替她负责，她哭笑着接受边界，主动牵手说以后想靠近时会直接说喜欢。' },
  { id: 'mebuki_side_no_loan_week', name: '芽吹支线·不借钱的一周', task_category: 'character_side', character_group: '山师芽吹', content: '保持负债为 0 并累计完成 6 笔交易，陪芽吹完成一周生活与交易预算。', conditions: [condition('debt', 'eq', 0, '负债保持为 0'), condition('trade_count', 'gte', 6, '累计交易 6 笔')], complete_prompt: '扩写芽吹完成无负债预算周的生活喜剧：她被打折广告和行情消息轮番诱惑，几次想透支未来收入，却在用户提醒下亲自删掉借贷申请。六笔交易结束后，她拿着仍有余额的预算表得意炫耀，又承认克制比想象中更有成就感。结尾她用省下的钱买了两杯饮料，并制定下一周由自己执行的新计划。' },

  { id: 'yasuko_side_blog', name: '康子支线·只给你看的新草稿', task_category: 'character_side', character_group: '高根康子', unlock_affection: 45, unlock_affection_current: affection.yasuko, content: '好感度达到 45 后解锁。帮助康子写一篇不鼓吹投机的新博客，并成为她第一个信任的读者；无金融完成条件。', complete_prompt: '扩写好感度四十五时的深夜改稿：康子对旧网名既怀念又羞耻，只肯让用户坐在身边看未完成的草稿。两人把炫耀收益改为讲述风险和重新生活，她因用户没有嘲笑惨败而渐渐放松，困倦时自然靠上用户肩膀。文章收到感谢留言后，她红着眼眶握住用户的手，嘴硬说只是需要一个固定校对，却把以后每篇文章的第一读者都留给用户。' },
  { id: 'yasuko_side_debt_free', name: '康子支线·无债后的两人餐桌', task_category: 'character_side', character_group: '高根康子', unlock_affection: 73, unlock_affection_current: affection.yasuko, content: '好感度达到 73 且负债降至 0 后解锁剧情。与康子共享一顿不靠冒险换来的安心晚餐。', conditions: [condition('debt', 'eq', 0, '负债保持为 0')], complete_prompt: '扩写好感度七十三时的无债晚餐：康子确认账户归零后没有鼓励再次冒险，而是在便宜温暖的小店认真夸奖用户。她谈起自己最狼狈的催债经历时仍会发抖，用户在得到允许后握住她的手，她没有像平日那样逞强照顾别人。回家路上她主动挽住用户，坦白想要以后也有这样的两人餐桌，结尾小声问用户是否愿意把她算进普通生活的预算里。' },
  { id: 'yasuko_side_studio_fund', name: '康子支线·工作台升级计划', task_category: 'character_side', character_group: '高根康子', content: '现金余额达到 150000，与康子为创作设备制定一份不透支生活的采购计划。', conditions: [condition('cash', 'gte', 150000, '现金余额 150000')], complete_prompt: '扩写十五万现金储备下的采购日常：康子面对心仪的绘图设备反复计算，坚决不肯动用生活安全垫。用户陪她比较价格和真实需求，也尊重她以设计谋生的专业判断。两人最终选出可负担的升级方案，剩余资金继续保留；结尾她在新工作台画下第一张小小合影，感谢用户支持的是她的创作而不是投机翻身。' },

  { id: 'saya_side_game', name: '纱夜支线·不装笨的双人通关', task_category: 'character_side', character_group: '山吹纱夜', unlock_affection: 45, unlock_affection_current: affection.saya, content: '好感度达到 45 后解锁。与纱夜完成双人关卡，让她无需装弱也能坦率请求亲近；无金融完成条件。', complete_prompt: '扩写好感度四十五时的双人游戏夜：纱夜起初故意装不会以便靠近哥哥，被识破后没有继续扮可怜，而是红着脸直说想坐得近一些。哥哥接受她坦率的请求，也认真称赞她关键时刻的熟练操作。通关后她不再以生病为理由挽留，只问能否再陪一会儿；结尾两人分享耳机和毯子，她安心靠在哥哥肩上睡着。' },
  { id: 'saya_side_reserve', name: '纱夜支线·把未来写成我们', task_category: 'character_side', character_group: '山吹纱夜', unlock_affection: 73, unlock_affection_current: affection.saya, content: '好感度达到 73 且现金余额达到 100000 后解锁剧情。共同建立治疗与生活储备，并谈清依赖、健康和未来边界。', conditions: [condition('cash', 'gte', 100000, '现金余额 100000')], complete_prompt: '扩写好感度七十三时的家庭预算夜：纱夜偷偷用过度节省伤害自己的方式减轻哥哥压力，被发现后终于承认她怕自己只是负担。哥哥拒绝她以健康换取被需要，也明确说明亲密不因她逐渐独立而消失。两人并肩重写十万储备的用途，她主动加入治疗、升学和各自空间；结尾纱夜把“哥哥一个人承担”改成“我们自愿一起商量”，请求一个不靠装可怜换来的拥抱。' },
  { id: 'saya_side_independent_plan', name: '纱夜支线·自己的四次选择', task_category: 'character_side', character_group: '山吹纱夜', content: '累计完成 4 笔交易，在哥哥不代替决定的前提下，由纱夜参与制定四项生活选择。', conditions: [condition('trade_count', 'gte', 4, '累计交易 4 笔')], complete_prompt: '扩写四笔交易复盘延伸出的生活规划：纱夜习惯性地让哥哥替她决定，却在每次询问后尝试说出自己的理由。两人把这种练习延伸到复诊安排、课程、休息和兴趣，她发现独立选择并不会让哥哥离开。结尾她完整提出一项自己的计划，也主动为可能的结果负责；哥哥陪伴但不接管，她笑着牵手说想继续练习并肩。' },

  { id: 'side_first_trade', name: '插件支线·第一份成交记录', task_category: 'side', content: '完成至少 1 笔交易。目标：累计交易 1 笔；任务页会显示当前次数及差距。', conditions: [condition('trade_count', 'gte', 1, '累计交易 1 笔')], complete_prompt: '扩写一段简短的交易复盘剧情：用户完成第一笔成交后，身边角色陪用户查看成交记录、费用与仓位变化，提醒这只是熟悉工具而非证明投资天赋。剧情落点是用户理解每次操作都会留下可复盘的数据。' },
  { id: 'side_trade_volume', name: '插件支线·理解成交额', task_category: 'side', content: '累计成交额达到 100000。任务页会显示当前累计成交额及离 100000 还差多少。', conditions: [condition('total_trade_amount', 'gte', 100000, '累计成交额 100000')], complete_prompt: '扩写一段围绕累计成交额的教学剧情：角色指出成交额不等于盈利，带用户对照多笔订单、手续费和实际盈亏。避免夸大成功，结尾让用户明确频繁交易会放大成本，今后会先确认目的再操作。' },
  { id: 'side_cash_buffer', name: '插件支线·保留安全垫', task_category: 'side', content: '现金余额达到 100000。任务页会显示当前现金及离 100000 还差多少。', conditions: [condition('cash', 'gte', 100000, '现金余额 100000')], complete_prompt: '扩写一段建立现金安全垫的生活剧情：角色与用户一起核对账户，说明未投入市场的现金也有价值，它承担账单、医疗和突发事件。结尾以一次克制住满仓冲动的选择收束，让安全感来自可用余地而不是预测必胜。' },
  { id: 'side_profit', name: '插件支线·第一次累计盈利', task_category: 'side', content: '累计盈利达到 100000。任务页会显示当前累计盈利及离 100000 还差多少。', conditions: [condition('profit', 'gte', 100000, '累计盈利 100000')], complete_prompt: '扩写累计盈利十万后的复盘剧情：角色允许用户庆祝，但共同检查盈利来源、风险暴露与是否可重复，明确账面上的顺利不代表下一次必然成功。结尾由用户主动保留部分成果并记录策略，而不是立刻加码。' },
  { id: 'side_debt_control', name: '插件支线·清理负债', task_category: 'side', content: '将负债降至 0。任务页会显示当前负债是否已达到目标。', conditions: [condition('debt', 'eq', 0, '负债保持为 0')], complete_prompt: '扩写债务归零后的安静庆祝：用户与角色核对最后一笔还款和账户变化，回顾负债带来的压力以及曾经的错误冲动。庆祝保持朴素，剧情落点是重新建立预算和底线，不把无债状态当作再次借贷投机的资格。' }
];

// 手机页只按 main / character / side 建立顶层折叠；角色内部再按子类型展示。
for (const task of tasks) {
  if (task.task_category === 'character_main') {
    task.task_category = 'character';
    task.task_subcategory = 'main';
  } else if (task.task_category === 'affection') {
    task.task_category = 'character';
    task.task_subcategory = 'affection';
  } else if (task.task_category === 'character_side') {
    task.task_category = 'character';
    task.task_subcategory = 'side';
  }
  if (task.task_category === 'main' && task.character_group) task.task_subcategory = 'main';
}
%><%- JSON.stringify({ tasks: tasks }, null, 2) %>
```

## 数值总览

| 角色 | 第一阶段（好感度 30） | 第二阶段（好感度 60） | 第三阶段（好感度 85） |
|---|---|---|---|
| 福贺久留美 | `trade_count >= 3` | `profit >= 300000` | `net_worth >= 20000000` |
| 小金萌智子 | `total_assets >= 500000` | `debt == 0` 且 `trade_count >= 8` | `net_worth >= 10000000` |
| 山师芽吹 | `trade_count >= 5` | `max_position_amount >= 300000` 且 `total_trade_amount >= 1000000` | `profit >= 400000` 且 `debt == 0` |
| 高根康子 | `cash >= 200000` | `debt == 0` 且 `net_worth >= 500000` | `net_worth >= 2000000` |
| 山吹纱夜 | `cash >= 300000` | `total_assets >= 1000000` | `net_worth >= 3000000` 且 `debt == 0` |

这些目标读取玩家账户。若要让某项任务读取角色的多账户数据，可在对应任务或步骤中增加 `account_id: '实际账户ID'`。
