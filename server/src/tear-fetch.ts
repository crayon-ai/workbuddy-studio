/**
 * 脚本拆解的确定性抓取：后端直连下载素材原文与媒体，替代 agent 逐工具调用。
 * 动机（性能）：抓取/下载/转码/转写是确定性工作，无需 AI 判断——agent 模式下每个动作
 * 都是一次 API 往返，一条 B 站视频要 12-14 分钟；后端并行直连可压到几十秒。
 * 产出与 agent 抓取相同的原文库结构：sources/<sha1(url)>/{正文.md, 图片/, 图片文字.md?, 逐字稿.md?}
 * 抓不到有效内容返回 ok=false，由调用方回退 agent 全流程兜底（反爬场景仍可用）。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

/** 本机 whisper.cpp server（setup-whisper.sh 起在 2022，OpenAI 兼容口） */
const WHISPER_ENDPOINT = "http://127.0.0.1:2022/v1/audio/transcriptions";

/**
 * 繁→简全量单字映射（由 OpenCC t2s 生成；whisper 中文转写偏繁体，逐字稿统一转简体）。
 * 繁→简方向基本一对一，单字映射即可；表外字符原样保留。
 */
const T2S_PAIRS =
  "㑮𫝈㑯㑔㑳㑇㑶㐹㒓𠉂㓄𪠟㓨刾㔋𪟎㖮𪠵㗲𠵾㗿𪡛㘉𠰱㘓𪢌㘔𫬐㘚㘎㛝𫝦㜄㚯㜏㛣㜐𫝧㜗𡞋㜢𡞱㜷𡝠㞞𪨊㟺𪩇㠏㟆㠣𫵷㢗𪪑㢝𢋈㥮㤘㦎𢛯㦛𢗓㦞𪫷㨻𪮃㩋𪮋㩜㨫㩳㧐㩵擜㪎𪯋㯤𣘐㰙𣗙㵗𣳆㵾𪷍㶆𫞛㷍𤆢㷿𤈷㸇𤎺㹽𫞣㺏𤠋㺜𪺻㻶𪼋㿖𪽮㿗𤻊㿧𤽯䀉𥁢䀹𥅴䁪𥇢䁻䀥䂎𥎝䃮鿎䅐𫀨" +
  "䅳𫀬䆉𫁂䉑𫁲䉙𥬀䉬𫂈䉲𥮜䉶𫁷䊭𥺅䊷䌶䊺𫄚䋃𫄜䋔𫄞䋙䌺䋚䌻䋦𫄩䋹䌿䋻䌾䋼𫄮䋿𦈓䌈𦈖䌋𦈘䌖𦈜䌝𦈟䌟𦈞䌥𦈠䌰𦈙䍤𫅅䍦䍠䍽𦍠䎙𫅭䎱䎬䓣𬜯䕤𫟕䕳𦰴䖅𫟑䗅𫊪䗿𧉞䙔𫋲䙡䙌䙱𧜭䚩𫌯䛄𫍠䛳𫍫䜀䜧䜖𫟢䝭𫎧䝻𧹕䝼䞍䞈𧹑䞋𫎪䞓𫎭䟃𫎺䟆𫎳䟐𫎱䠆𫏃䠱𨅛䡐𫟤䡩𫟥䡵𫟦䢨𨑹" +
  "䤤𫟺䥄𫠀䥇䦂䥑鿏䥕𬭯䥗𫔋䥩𨱖䥯𫔆䥱䥾䦘𨸄䦛䦶䦟䦷䦯𫔵䦳𨷿䧢𨸟䪊𫖅䪏𩏼䪗𩐀䪘𩏿䪴𫖫䪾𫖬䫀𫖱䫂𫖰䫟𫖲䫴𩖗䫶𫖺䫻𫗇䫾𫠈䬓𫗊䬘𩙮䬝𩙯䬞𩙧䬧𫗟䭀𩠇䭃𩠈䭑𫗱䭔𫗰䭿𩧭䮄𫠊䮝𩧰䮞𩨁䮠𩧿䮫𩨇䮰𫘮䮳𩨏䮾𩧪䯀䯅䯤𩩈䰾鲃䱀𫚐䱁𫚏䱙𩾈䱧𫚠䱬𩾊䱰𩾋䱷䲣䱸𫠑䱽䲝䲁鳚䲅𫚜" +
  "䲖𩾂䲘鳤䲰𪉂䳜𫛬䳢𫛰䳤𫛮䳧𫛺䳫𫛼䴉鹮䴋𫜅䴬𪎈䴱𫜒䴴𪎋䴽𫜔䵳𪑅䵴𫜙䶕𫜨䶲𫜳丟丢並并乾干亂乱亙亘亞亚佇伫佈布佔占併并來来侖仑侶侣侷局俁俣係系俓𠇹俔伣俠侠俥伡俬私倀伥倆俩倈俫倉仓個个們们倖幸倫伦倲㑈偉伟偑㐽側侧偵侦偽伪傌㐷傑杰傖伧傘伞備备傢家傭佣" +
  "傯偬傳传傴伛債债傷伤傾倾僂偻僅仅僉佥僑侨僕仆僞伪僤𫢸僥侥僨偾僱雇價价儀仪儁俊儂侬億亿儈侩儉俭儎傤儐傧儔俦儕侪儘尽償偿儣𠆲優优儭𠋆儲储儷俪儸㑩儺傩儻傥儼俨兇凶兌兑兒儿兗兖內内兩两冊册冑胄冪幂凈净凍冻凙𪞝凜凛凱凯別别刪删剄刭則则剋克剎刹剗刬剛刚" +
  "剝剥剮剐剴剀創创剷铲剾𠛅劃划劇剧劉刘劊刽劌刿劍剑劏㓥劑剂劚㔉勁劲勑𠡠動动務务勛勋勝胜勞劳勢势勣𪟝勩勚勱劢勳勋勵励勸劝勻匀匭匦匯汇匱匮區区協协卹恤卻却卽即厙厍厠厕厤历厭厌厲厉厴厣參参叄叁叢丛吒咤吳吴吶呐呂吕咼呙員员哯𠯟唄呗唓𪠳唸念問问啓启啞哑" +
  "啟启啢唡喎㖞喚唤喪丧喫吃喬乔單单喲哟嗆呛嗇啬嗊唝嗎吗嗚呜嗩唢嗰𠮶嗶哔嗹𪡏嘆叹嘍喽嘓啯嘔呕嘖啧嘗尝嘜唛嘩哗嘪𪡃嘮唠嘯啸嘰叽嘳𪡞嘵哓嘸呒嘺𪡀嘽啴噁恶噅𠯠噓嘘噚㖊噝咝噞𪡋噠哒噥哝噦哕噯嗳噲哙噴喷噸吨噹当嚀咛嚇吓嚌哜嚐尝嚕噜嚙啮嚛𪠸嚥咽嚦呖嚧𠰷嚨咙" +
  "嚮向嚲亸嚳喾嚴严嚶嘤嚽𪢕囀啭囁嗫囂嚣囃𠱞囅冁囈呓囉啰囌苏囑嘱囒𪢠囪囱圇囵國国圍围園园圓圆圖图團团圞𪢮垻坝埡垭埨𫭢埬𪣆埰采執执堅坚堊垩堖垴堚𪣒堝埚堯尧報报場场塊块塋茔塏垲塒埘塗涂塚冢塢坞塤埙塵尘塸𫭟塹堑塿𪣻墊垫墜坠墠𫮃墮堕墰坛墲𪢸墳坟墶垯墻墙" +
  "墾垦壇坛壈𡒄壋垱壎埙壓压壗𡋤壘垒壙圹壚垆壜坛壞坏壟垄壠垅壢坜壣𪤚壩坝壪塆壯壮壺壶壼壸壽寿夠够夢梦夥伙夾夹奐奂奧奥奩奁奪夺奬奖奮奋奼姹妝妆姍姗姦奸娙𫰛娛娱婁娄婡𫝫婦妇婭娅媈𫝨媧娲媯妫媰㛀媼媪媽妈嫋袅嫗妪嫵妩嫺娴嫻娴嫿婳嬀妫嬃媭嬇𫝬嬈娆嬋婵嬌娇" +
  "嬙嫱嬡嫒嬣𪥰嬤嬷嬦𫝩嬪嫔嬰婴嬸婶嬻𪥿孃娘孄𫝮孆𫝭孇𪥫孋㛤孌娈孎𡠟孫孙學学孻𡥧孾𪧀孿孪宮宫寀采寠𪧘寢寝實实寧宁審审寫写寬宽寵宠寶宝將将專专尋寻對对導导尷尴屆届屍尸屓屃屜屉屢屡層层屨屦屩𪨗屬属岡冈峯峰峴岘島岛峽峡崍崃崑昆崗岗崙仑崢峥崬岽嵐岚嵗岁" +
  "嵼𡶴嵽𫶇嵾㟥嶁嵝嶄崭嶇岖嶈𡺃嶔嵚嶗崂嶘𡺄嶠峤嶢峣嶧峄嶨峃嶮崄嶸嵘嶹𫝵嶺岭嶼屿嶽岳巊𪩎巋岿巒峦巔巅巖岩巗𪨷巘𪩘巰巯巹卺帥帅師师帳帐帶带幀帧幃帏幓㡎幗帼幘帻幝𪩷幟帜幣币幩𪩸幫帮幬帱幹干幾几庫库廁厕廂厢廄厩廈厦廎庼廕荫廚厨廝厮廞𫷷廟庙廠厂廡庑廢废" +
  "廣广廧𪪞廩廪廬庐廳厅弒弑弔吊弳弪張张強强彃𪪼彄𫸩彆别彈弹彌弥彎弯彔录彙汇彠彟彥彦彫雕彲彨彿佛後后徑径從从徠徕復复徵征徹彻徿𪫌恆恒恥耻悅悦悞悮悵怅悶闷悽凄惡恶惱恼惲恽惻恻愛爱愜惬愨悫愴怆愷恺愻𢙏愾忾慄栗態态慍愠慘惨慚惭慟恸慣惯慤悫慪怄慫怂慮虑" +
  "慳悭慶庆慺㥪慼戚慾欲憂忧憊惫憐怜憑凭憒愦憖慭憚惮憢𢙒憤愤憫悯憮怃憲宪憶忆憸𪫺憹𢙐懀𢙓懇恳應应懌怿懍懔懎𢠁懞蒙懟怼懣懑懤㤽懨恹懲惩懶懒懷怀懸悬懺忏懼惧懾慑戀恋戇戆戔戋戧戗戩戬戰战戱戯戲戏戶户拋抛挩捝挱挲挾挟捨舍捫扪捱挨捲卷掃扫掄抡掆㧏掗挜掙挣" +
  "掚𪭵掛挂採采揀拣揚扬換换揮挥揯搄損损搖摇搗捣搵揾搶抢摋𢫬摐𪭢摑掴摜掼摟搂摯挚摳抠摶抟摺折摻掺撈捞撊𪭾撏挦撐撑撓挠撝㧑撟挢撣掸撥拨撧𪮖撫抚撲扑撳揿撻挞撾挝撿捡擁拥擄掳擇择擊击擋挡擓㧟擔担據据擟𪭧擠挤擣捣擫𢬍擬拟擯摈擰拧擱搁擲掷擴扩擷撷擺摆擻擞" +
  "擼撸擽㧰擾扰攄摅攆撵攋𪮶攏拢攔拦攖撄攙搀攛撺攜携攝摄攢攒攣挛攤摊攪搅攬揽敎教敓敚敗败敘叙敵敌數数斂敛斃毙斅𢽾斆敩斕斓斬斩斷断斸𣃁於于旂旗旣既昇升時时晉晋晛𬀪晝昼暈晕暉晖暐𬀩暘旸暢畅暫暂曄晔曆历曇昙曉晓曊𪰶曏向曖暧曠旷曥𣆐曨昽曬晒書书會会朥𦛨" +
  "朧胧朮术東东枴拐柵栅柺拐査查桱𣐕桿杆梔栀梖𪱷梘枧梜𬂩條条梟枭梲棁棄弃棊棋棖枨棗枣棟栋棡㭎棧栈棲栖棶梾椏桠椲㭏楇𣒌楊杨楓枫楨桢業业極极榘矩榦干榪杩榮荣榲榅榿桤構构槍枪槓杠槤梿槧椠槨椁槫𣏢槮椮槳桨槶椢槼椝樁桩樂乐樅枞樑梁樓楼標标樞枢樠𣗊樢㭤樣样" +
  "樤𣔌樧榝樫㭴樳桪樸朴樹树樺桦樿椫橈桡橋桥機机橢椭橫横橯𣓿檁檩檉柽檔档檜桧檟槚檢检檣樯檭𣘴檮梼檯台檳槟檵𪲛檸柠檻槛櫃柜櫅𪲎櫍𬃊櫓橹櫚榈櫛栉櫝椟櫞橼櫟栎櫠𪲮櫥橱櫧槠櫨栌櫪枥櫫橥櫬榇櫱蘖櫳栊櫸榉櫻樱欄栏欅榉欇𪳍權权欍𣐤欏椤欐𪲔欑𪴙欒栾欓𣗋欖榄欘𣚚" +
  "欞棂欽钦歎叹歐欧歟欤歡欢歲岁歷历歸归歿殁殘残殞殒殢𣨼殤殇殨㱮殫殚殭僵殮殓殯殡殰㱩殲歼殺杀殻壳殼壳毀毁毆殴毊𪵑毿毵氂牦氈毡氌氇氣气氫氢氬氩氭𣱝氳氲氾泛汎泛汙污決决沒没沖冲況况泝溯洩泄洶汹浹浃浿𬇙涇泾涗涚涼凉淒凄淚泪淥渌淨净淩凌淪沦淵渊淶涞淺浅" +
  "渙涣減减渢沨渦涡測测渾浑湊凑湋𣲗湞浈湧涌湯汤溈沩準准溝沟溡𪶄溫温溮浉溳涢溼湿滄沧滅灭滌涤滎荥滙汇滬沪滯滞滲渗滷卤滸浒滻浐滾滚滿满漁渔漊溇漍𬇹漚沤漢汉漣涟漬渍漲涨漵溆漸渐漿浆潁颍潑泼潔洁潕𣲘潙沩潚㴋潛潜潣𫞗潤润潯浔潰溃潷滗潿涠澀涩澅𣶩澆浇澇涝" +
  "澐沄澗涧澠渑澤泽澦滪澩泶澫𬇕澬𫞚澮浍澱淀澾㳠濁浊濃浓濄㳡濆𣸣濕湿濘泞濚溁濛蒙濜浕濟济濤涛濧㳔濫滥濰潍濱滨濺溅濼泺濾滤濿𪵱瀂澛瀃𣽷瀅滢瀆渎瀇㲿瀉泻瀋沈瀏浏瀕濒瀘泸瀝沥瀟潇瀠潆瀦潴瀧泷瀨濑瀰弥瀲潋瀾澜灃沣灄滠灍𫞝灑洒灒𪷽灕漓灘滩灙𣺼灝灏灡㳕灣湾" +
  "灤滦灧滟灩滟災灾為为烏乌烴烃無无煇𪸩煉炼煒炜煙烟煢茕煥焕煩烦煬炀煱㶽熂𪸕熅煴熉𤈶熌𤇄熒荧熓𤆡熗炝熚𤇹熡𤋏熰𬉼熱热熲颎熾炽燀𬊤燁烨燈灯燉炖燒烧燖𬊈燙烫燜焖營营燦灿燬毁燭烛燴烩燶㶶燻熏燼烬燾焘爃𫞡爄𤇃爇𦶟爍烁爐炉爖𤇭爛烂爥𪹳爧𫞠爭争爲为爺爷爾尔" +
  "牀床牆墙牘牍牽牵犖荦犛牦犞𪺭犢犊犧牺狀状狹狭狽狈猌𪺽猙狰猶犹猻狲獁犸獃呆獄狱獅狮獊𪺷獎奖獨独獩𤞃獪狯獫猃獮狝獰狞獱㺍獲获獵猎獷犷獸兽獺獭獻献獼猕玀猡玁𤞤珼𫞥現现琱雕琺珐琿珲瑋玮瑒玚瑣琐瑤瑶瑩莹瑪玛瑲玱瑻𪻲瑽𪻐璉琏璊𫞩璕𬍤璗𬍡璝𪻺璡琎璣玑璦瑷" +
  "璫珰璯㻅環环璵玙璸瑸璼𫞨璽玺璾𫞦璿璇瓄𪻨瓅𬍛瓊琼瓏珑瓔璎瓕𤦀瓚瓒瓛𤩽甌瓯甕瓮產产産产甦苏甯宁畝亩畢毕畫画異异畵画當当畼𪽈疇畴疊叠痙痉痠酸痮𪽪痾疴瘂痖瘋疯瘍疡瘓痪瘞瘗瘡疮瘧疟瘮瘆瘱𪽷瘲疭瘺瘘瘻瘘療疗癆痨癇痫癉瘅癐𤶊癒愈癘疠癟瘪癡痴癢痒癤疖癥症" +
  "癧疬癩癞癬癣癭瘿癮瘾癰痈癱瘫癲癫發发皁皂皚皑皟𤾀皰疱皸皲皺皱盃杯盜盗盞盏盡尽監监盤盘盧卢盨𪾔盪荡眝𪾣眞真眥眦眾众睍𪾢睏困睜睁睞睐瞘眍瞜䁖瞞瞒瞤𥆧瞶瞆瞼睑矇蒙矉𪾸矑𪾦矓眬矚瞩矯矫硃朱硜硁硤硖硨砗硯砚碕埼碙𥐻碩硕碭砀碸砜確确碼码碽䂵磑硙磚砖磠硵" +
  "磣碜磧碛磯矶磽硗磾䃅礄硚礆硷礎础礐𬒈礒𥐟礙碍礦矿礪砺礫砾礬矾礮𪿫礱砻祕秘祿禄禍祸禎祯禕祎禡祃禦御禪禅禮礼禰祢禱祷禿秃秈籼稅税稈秆稏䅉稜棱稟禀種种稱称穀谷穇䅟穌稣積积穎颖穠秾穡穑穢秽穩稳穫获穭穞窩窝窪洼窮穷窯窑窵窎窶窭窺窥竄窜竅窍竇窦竈灶竊窃" +
  "竚𥩟竪竖竱𫁟競竞筆笔筍笋筧笕筴䇲箇个箋笺箏筝節节範范築筑篋箧篔筼篘𥬠篠筿篢𬕂篤笃篩筛篳筚篸𥮾簀箦簂𫂆簍篓簑蓑簞箪簡简簢𫂃簣篑簫箫簹筜簽签簾帘籃篮籅𥫣籋𥬞籌筹籔䉤籙箓籛篯籜箨籟籁籠笼籤签籩笾籪簖籬篱籮箩籲吁粵粤糉粽糝糁糞粪糧粮糰团糲粝糴籴糶粜" +
  "糹纟糺𫄙糾纠紀纪紂纣紃𬘓約约紅红紆纡紇纥紈纨紉纫紋纹納纳紐纽紓纾純纯紕纰紖纼紗纱紘纮紙纸級级紛纷紜纭紝纴紞𬘘紟𫄛紡纺紬䌷紮扎細细紱绂紲绁紳绅紵纻紹绍紺绀紼绋紿绐絀绌絁𫄟終终絃弦組组絅䌹絆绊絍𫟃絎绗結结絕绝絙𫄠絛绦絝绔絞绞絡络絢绚絥𫄢給给絧𫄡" +
  "絨绒絪𬘡絰绖統统絲丝絳绛絶绝絹绢絺𫄨綀𦈌綁绑綃绡綄𬘫綆绠綇𦈋綈绨綉绣綋𫟄綌绤綎𬘩綏绥綐䌼綑捆經经綖𫄧綜综綝𬘭綞缍綟𫄫綠绿綡𫟅綢绸綣绻綧𬘯綪𬘬綫线綬绶維维綯绹綰绾綱纲網网綳绷綴缀綵彩綸纶綹绺綺绮綻绽綽绰綾绫綿绵緄绲緇缁緊紧緋绯緍𦈏緑绿緒绪緓绬" +
  "緔绱緗缃緘缄緙缂線线緝缉緞缎緟𫟆締缔緡缗緣缘緤𫄬緦缌編编緩缓緬缅緮𫄭緯纬緰𦈕緱缑緲缈練练緶缏緷𦈉緸𦈑緹缇緻致緼缊縈萦縉缙縊缢縋缒縍𫄰縎𦈔縐绉縑缣縕缊縗缞縛缚縝缜縞缟縟缛縣县縧绦縫缝縬𦈚縭缡縮缩縯𬙂縰𫄳縱纵縲缧縳䌸縴纤縵缦縶絷縷缕縸𫄲縹缥縺𦈐" +
  "總总績绩繂𫄴繃绷繅缫繆缪繈𫄶繏𦈝繐𰬸繒缯繓𦈛織织繕缮繚缭繞绕繟𦈎繡绣繢缋繨𫄤繩绳繪绘繫系繬𫄱繭茧繮缰繯缳繰缲繳缴繶𫄷繷𫄣繸䍁繹绎繻𦈡繼继繽缤繾缱繿䍀纁𫄸纆𬙊纇颣纈缬纊纩續续纍累纏缠纓缨纔才纕𬙋纖纤纗𫄹纘缵纚𫄥纜缆缽钵罃䓨罈坛罌罂罎坛罰罚罵骂" +
  "罷罢羅罗羆罴羈羁羋芈羣群羥羟羨羡義义羵𫅗羶膻習习翫玩翬翚翹翘翽翙耬耧耮耢聖圣聞闻聯联聰聪聲声聳耸聵聩聶聂職职聹聍聻𫆏聽听聾聋肅肃脅胁脈脉脛胫脣唇脥𣍰脩修脫脱脹胀腎肾腖胨腡脶腦脑腪𣍯腫肿腳脚腸肠膃腽膕腘膚肤膞䏝膠胶膢𦝼膩腻膹𪱥膽胆膾脍膿脓臉脸" +
  "臍脐臏膑臗𣎑臘腊臚胪臟脏臠脔臢臜臥卧臨临臺台與与興兴舉举舊旧舘馆艙舱艣𫇛艤舣艦舰艫舻艱艰艷艳芻刍苧苎茲兹荊荆莊庄莖茎莢荚莧苋菕𰰨華华菴庵菸烟萇苌萊莱萬万萴荝萵莴葉叶葒荭葝𫈎葤荮葦苇葯药葷荤蒍𫇭蒐搜蒓莼蒔莳蒕蒀蒞莅蒭𫇴蒼苍蓀荪蓆席蓋盖蓧𦰏蓮莲" +
  "蓯苁蓴莼蓽荜蔄𬜬蔔卜蔘参蔞蒌蔣蒋蔥葱蔦茑蔭荫蔯𫈟蔿𫇭蕁荨蕆蒇蕎荞蕒荬蕓芸蕕莸蕘荛蕝𫈵蕢蒉蕩荡蕪芜蕭萧蕳𫈉蕷蓣蕽𫇽薀蕰薆𫉁薈荟薊蓟薌芗薑姜薔蔷薘荙薟莶薦荐薩萨薳䓕薴苧薵䓓薹苔薺荠藍蓝藎荩藝艺藥药藪薮藭䓖藴蕴藶苈藷𫉄藹蔼藺蔺蘀萚蘄蕲蘆芦蘇苏蘊蕴" +
  "蘋苹蘚藓蘞蔹蘟𦻕蘢茏蘭兰蘺蓠蘿萝虆蔂虉𬟁處处虛虚虜虏號号虧亏虯虬蛺蛱蛻蜕蜆蚬蝀𬟽蝕蚀蝟猬蝦虾蝨虱蝸蜗螄蛳螞蚂螢萤螮䗖螻蝼螿螀蟂𫋇蟄蛰蟈蝈蟎螨蟘𫋌蟜𫊸蟣虮蟬蝉蟯蛲蟲虫蟳𫊻蟶蛏蟻蚁蠀𧏗蠁蚃蠅蝇蠆虿蠍蝎蠐蛴蠑蝾蠔蚝蠙𧏖蠟蜡蠣蛎蠦𫊮蠨蟏蠱蛊蠶蚕蠻蛮" +
  "蠾𧑏衆众衊蔑術术衕同衚胡衛卫衝冲袞衮裊袅裏里補补裝装裡里製制複复褌裈褘袆褲裤褳裢褸褛褻亵襀𫌀襇裥襉裥襏袯襓𫋹襖袄襗𫋷襘𫋻襝裣襠裆襤褴襪袜襬摆襯衬襰𧝝襲袭襴襕襵𫌇覈核見见覎觃規规覓觅視视覘觇覛𫌪覡觋覥觍覦觎親亲覬觊覯觏覲觐覷觑覹𫌭覺觉覼𫌨覽览" +
  "覿觌觀观觴觞觶觯觸触訁讠訂订訃讣計计訊讯訌讧討讨訏𬣙訐讦訑𫍙訒讱訓训訕讪訖讫託托記记訛讹訜𫍛訝讶訞𫍚訟讼訢䜣訣诀訥讷訨𫟞訩讻訪访設设許许訴诉訶诃診诊註注証证詀𧮪詁诂詆诋詊𫟟詎讵詐诈詑𫍡詒诒詓𫍜詔诏評评詖诐詗诇詘诎詛诅詝𬣞詞词詠咏詡诩詢询詣诣" +
  "試试詩诗詪𬣳詫诧詬诟詭诡詮诠詰诘話话該该詳详詵诜詷𫍣詼诙詿诖誂𫍥誄诔誅诛誆诓誇夸誋𫍪誌志認认誑诳誒诶誕诞誘诱誚诮語语誠诚誡诫誣诬誤误誥诰誦诵誨诲說说誫𫍨説说誰谁課课誳𫍮誴𫟡誶谇誷𫍬誹诽誺𫍧誼谊誾訚調调諂谄諄谆談谈諉诿請请諍诤諏诹諑诼諒谅諓𬣡" +
  "論论諗谂諛谀諜谍諝谞諞谝諟𬤊諡谥諢诨諣𫍩諤谔諥𫍳諦谛諧谐諫谏諭谕諮咨諯𫍱諰𫍰諱讳諲𬤇諳谙諴𫍯諶谌諷讽諸诸諺谚諼谖諾诺謀谋謁谒謂谓謄誊謅诌謆𫍸謉𫍷謊谎謎谜謏𫍲謐谧謔谑謖谡謗谤謙谦謚谥講讲謝谢謠谣謡谣謨谟謫谪謬谬謭谫謯𫍹謱𫍴謳讴謸𫍵謹谨謾谩譁哗" +
  "譂𫟠譅𰶎譆𫍻證证譊𫍢譎谲譏讥譑𫍤譓𬤝譖谮識识譙谯譚谭譜谱譞𫍽譟噪譨𫍦譫谵譭毁譯译議议譴谴護护譸诪譽誉譾谫讀读讅谉變变讋詟讌䜩讎雠讒谗讓让讕谰讖谶讚赞讜谠讞谳豈岂豎竖豐丰豔艳豬猪豵𫎆豶豮貓猫貗𫎌貙䝙貝贝貞贞貟贠負负財财貢贡貧贫貨货販贩貪贪貫贯" +
  "責责貯贮貰贳貲赀貳贰貴贵貶贬買买貸贷貺贶費费貼贴貽贻貿贸賀贺賁贲賂赂賃赁賄贿賅赅資资賈贾賊贼賑赈賒赊賓宾賕赇賙赒賚赉賜赐賝𫎩賞赏賟𧹖賠赔賡赓賢贤賣卖賤贱賦赋賧赕質质賫赍賬账賭赌賰䞐賴赖賵赗賺赚賻赙購购賽赛賾赜贃𧹗贄贽贅赘贇赟贈赠贉𫎫贊赞贋赝" +
  "贍赡贏赢贐赆贑𫎬贓赃贔赑贖赎贗赝贚𫎦贛赣贜赃赬赪趕赶趙赵趨趋趲趱跡迹踐践踰逾踴踊蹌跄蹔𫏐蹕跸蹟迹蹠跖蹣蹒蹤踪蹳𫏆蹺跷蹻𫏋躂跶躉趸躊踌躋跻躍跃躎䟢躑踯躒跞躓踬躕蹰躘𨀁躚跹躝𨅬躡蹑躥蹿躦躜躪躏軀躯軉𨉗車车軋轧軌轨軍军軏𫐄軑轪軒轩軔轫軕𫐅軗𨐅軛轭" +
  "軜𫐇軝𬨂軟软軤轷軨𫐉軫轸軬𫐊軲轱軷𫐈軸轴軹轵軺轺軻轲軼轶軾轼軿𫐌較较輄𨐈輅辂輇辁輈辀載载輊轾輋𪨶輒辄輓挽輔辅輕轻輖𫐏輗𫐐輛辆輜辎輝辉輞辋輟辍輢𫐎輥辊輦辇輨𫐑輩辈輪轮輬辌輮𫐓輯辑輳辏輶𬨎輷𫐒輸输輻辐輼辒輾辗輿舆轀辒轂毂轄辖轅辕轆辘轇𫐖轉转轊𫐕" +
  "轍辙轎轿轐𫐗轔辚轗𫐘轟轰轠𫐙轡辔轢轹轣𫐆轤轳辦办辭辞辮辫辯辩農农迴回逕迳這这連连週周進进遊游運运過过達达違违遙遥遜逊遞递遠远遡溯適适遱𫐷遲迟遷迁選选遺遗遼辽邁迈還还邇迩邊边邏逻邐逦郟郏郵邮鄆郓鄉乡鄒邹鄔邬鄖郧鄟𫑘鄧邓鄩𬩽鄭郑鄰邻鄲郸鄳𫑡鄴邺" +
  "鄶郐鄺邝酇酂酈郦醃腌醖酝醜丑醞酝醟蒏醣糖醫医醬酱醱酦醲𬪩醶𫑷釀酿釁衅釃酾釅酽釋释釐厘釒钅釓钆釔钇釕钌釗钊釘钉釙钋釚𫟲針针釟𫓥釣钓釤钐釦扣釧钏釨𫓦釩钒釲𫟳釳𨰿釴𬬩釵钗釷钍釹钕釺钎釾䥺釿𬬱鈀钯鈁钫鈃钘鈄钭鈅钥鈆𫓪鈇𫓧鈈钚鈉钠鈋𨱂鈍钝鈎钩鈐钤鈑钣" +
  "鈒钑鈔钞鈕钮鈖𫟴鈗𫟵鈛𫓨鈞钧鈠𨱁鈡钟鈣钙鈥钬鈦钛鈧钪鈮铌鈯𨱄鈰铈鈲𨱃鈳钶鈴铃鈷钴鈸钹鈹铍鈺钰鈽钸鈾铀鈿钿鉀钾鉁𨱅鉅巨鉆钻鉈铊鉉铉鉊𬬿鉋铇鉍铋鉑铂鉔𫓬鉕钷鉗钳鉚铆鉛铅鉝𫟷鉞钺鉠𫓭鉢钵鉤钩鉥𬬸鉦钲鉧𬭁鉬钼鉭钽鉮𬬹鉳锫鉶铏鉷𫟹鉸铰鉺铒鉻铬鉽𫟸鉾𫓴" +
  "鉿铪銀银銁𫓲銂𫟻銃铳銅铜銈𫓯銊𫓰銍铚銏𫟶銑铣銓铨銖铢銘铭銚铫銛铦銜衔銠铑銣铷銥铱銦铟銨铵銩铥銪铕銫铯銬铐銱铞銳锐銶𨱇銷销銹锈銻锑銼锉鋁铝鋂𰾄鋃锒鋅锌鋇钡鋉𨱈鋌铤鋏铗鋐𬭎鋒锋鋗𫓶鋙铻鋝锊鋟锓鋠𫓵鋣铘鋤锄鋥锃鋦锔鋨锇鋩铓鋪铺鋭锐鋮铖鋯锆鋰锂鋱铽" +
  "鋶锍鋸锯鋹𬬮鋼钢錀𬬭錁锞錂𨱋錄录錆锖錇锫錈锩錏铔錐锥錒锕錕锟錘锤錙锱錚铮錛锛錜𫓻錝𫓽錞𬭚錟锬錠锭錡锜錢钱錤𫓹錥𫓾錦锦錨锚錩锠錫锡錮锢錯错録录錳锰錶表錸铼錼镎錽𫓸鍀锝鍁锨鍃锪鍄𨱉鍅钫鍆钔鍇锴鍈锳鍉𫔂鍊炼鍋锅鍍镀鍒𫔄鍔锷鍘铡鍚钖鍛锻鍠锽鍤锸鍥锲" +
  "鍩锘鍬锹鍭𬭤鍮𨱎鍰锾鍵键鍶锶鍺锗鍼针鍾钟鎂镁鎄锿鎇镅鎈𫟿鎊镑鎌镰鎍𫔅鎓𬭩鎔镕鎖锁鎘镉鎙𫔈鎚锤鎛镈鎝𨱏鎞𫔇鎡镃鎢钨鎣蓥鎦镏鎧铠鎩铩鎪锼鎬镐鎭镇鎮镇鎯𨱍鎰镒鎲镋鎳镍鎵镓鎶鿔鎷𨰾鎸镌鎿镎鏃镞鏆𨱌鏇旋鏈链鏉𨱒鏌镆鏍镙鏏𬭬鏐镠鏑镝鏗铿鏘锵鏚𬭭鏜镗鏝镘" +
  "鏞镛鏟铲鏡镜鏢镖鏤镂鏥𫔊鏦𫓩鏨錾鏰镚鏵铧鏷镤鏹镪鏺䥽鏻𬭸鏽锈鏾𫔌鐃铙鐄𨱑鐇𫔍鐈𫓱鐋铴鐍𫔎鐎𨱓鐏𨱔鐐镣鐒铹鐓镦鐔镡鐘钟鐙镫鐝镢鐠镨鐥䦅鐦锎鐧锏鐨镄鐩𬭼鐪𫓺鐫镌鐮镰鐯䦃鐲镯鐳镭鐵铁鐶镮鐸铎鐺铛鐼𫔁鐽𫟼鐿镱鑀𰾭鑄铸鑉𫠁鑊镬鑌镔鑑鉴鑒鉴鑔镲鑕锧鑞镴" +
  "鑠铄鑣镳鑥镥鑪𬬻鑭镧鑰钥鑱镵鑲镶鑴𫔔鑷镊鑹镩鑼锣鑽钻鑾銮鑿凿钁镢钂镋長长門门閂闩閃闪閆闫閈闬閉闭開开閌闶閍𨸂閎闳閏闰閐𨸃閑闲閒闲間间閔闵閗𫔯閘闸閝𫠂閞𫔰閡阂閣阁閤合閥阀閨闺閩闽閫阃閬阆閭闾閱阅閲阅閵𫔴閶阊閹阉閻阎閼阏閽阍閾阈閿阌闃阒闆板闇暗" +
  "闈闱闉𬮱闊阔闋阕闌阑闍阇闐阗闑𫔶闒阘闓闿闔阖闕阙闖闯關关闞阚闠阓闡阐闢辟闤阛闥闼陘陉陝陕陞升陣阵陰阴陳陈陸陆陽阳隉陧隊队階阶隑𬮿隕陨際际隤𬯎隨随險险隮𬯀隯陦隱隐隴陇隸隶隻只雋隽雖虽雙双雛雏雜杂雞鸡離离難难雲云電电霑沾霢霡霣𫕥霧雾霼𪵣霽霁靂雳" +
  "靄霭靆叇靈灵靉叆靚靓靜静靝靔靦腼靧𫖃靨靥鞏巩鞝绱鞦秋鞽鞒鞾𫖇韁缰韃鞑韆千韉鞯韋韦韌韧韍韨韓韩韙韪韚𫠅韛𫖔韜韬韝鞲韞韫韠𫖒韻韵響响頁页頂顶頃顷項项順顺頇顸須须頊顼頌颂頍𫠆頎颀頏颃預预頑顽頒颁頓顿頔𬱖頗颇領领頜颌頠𬱟頡颉頤颐頦颏頫𫖯頭头頮颒頰颊" +
  "頲颋頴颕頵𫖳頷颔頸颈頹颓頻频頽颓顂𩓋顃𩖖顅𫖶顆颗題题額额顎颚顏颜顒颙顓颛顔颜顗𫖮願愿顙颡顛颠類类顢颟顣𫖹顥颢顧顾顫颤顬颥顯显顰颦顱颅顳颞顴颧風风颭飐颮飑颯飒颰𩙥颱台颳刮颶飓颷𩙪颸飔颺飏颻飖颼飕颾𩙫飀飗飄飘飆飙飈飚飋𫗋飛飞飠饣飢饥飣饤飥饦飦𫗞" +
  "飩饨飪饪飫饫飭饬飯饭飱飧飲饮飴饴飵𫗢飶𫗣飼饲飽饱飾饰飿饳餃饺餄饸餅饼餈糍餉饷養养餌饵餎饹餏饻餑饽餒馁餓饿餔𫗦餕馂餖饾餗𫗧餘余餚肴餛馄餜馃餞饯餡馅餦𫗠餧𫗪館馆餪𫗬餫𫗥餬糊餭𫗮餱糇餳饧餵喂餶馉餷馇餸𩠌餺馎餼饩餾馏餿馊饁馌饃馍饅馒饈馐饉馑饊馓饋馈" +
  "饌馔饑饥饒饶饗飨饘𫗴饜餍饞馋饟𫗵饠𫗩饢馕馬马馭驭馮冯馯𫘛馱驮馳驰馴驯馹驲馼𫘜駁驳駃𫘝駉𬳶駊𫘟駎𩧨駐驻駑驽駒驹駓𬳵駔驵駕驾駘骀駙驸駚𩧫駛驶駝驼駞𫘞駟驷駡骂駢骈駤𫘠駧𩧲駩𩧴駪𬳽駫𫘡駭骇駰骃駱骆駶𩧺駸骎駻𫘣駼𬳿駿骏騁骋騂骍騃𫘤騄𫘧騅骓騉𫘥騊𫘦騌骔" +
  "騍骒騎骑騏骐騑𬴂騔𩨀騖骛騙骗騚𩨊騜𫘩騝𩨃騞𬴃騟𩨈騠𫘨騤骙騧䯄騪𩨄騫骞騭骘騮骝騰腾騱𫘬騴𫘫騵𫘪騶驺騷骚騸骟騻𫘭騼𫠋騾骡驀蓦驁骜驂骖驃骠驄骢驅驱驊骅驋𩧯驌骕驍骁驎𬴊驏骣驓𫘯驕骄驗验驙𫘰驚惊驛驿驟骤驢驴驤骧驥骥驦骦驨𫘱驪骊驫骉骯肮髏髅髒脏體体髕髌" +
  "髖髋髮发鬆松鬍胡鬖𩭹鬚须鬠𫘽鬢鬓鬥斗鬧闹鬨哄鬩阋鬮阄鬱郁鬹鬶魎魉魘魇魚鱼魛鱽魟𫚉魢鱾魥𩽹魦𫚌魨鲀魯鲁魴鲂魵𫚍魷鱿魺鲄魽𫠐鮀𬶍鮁鲅鮃鲆鮄𫚒鮅𫚑鮆𫚖鮈𬶋鮊鲌鮋鲉鮍鲏鮎鲇鮐鲐鮑鲍鮒鲋鮓鲊鮚鲒鮜鲘鮝鲞鮞鲕鮟𩽾鮠𬶏鮡𬶐鮣䲟鮤𫚓鮦鲖鮪鲔鮫鲛鮭鲑鮮鲜鮯𫚗" +
  "鮰𫚔鮳鲓鮵𫚛鮶鲪鮸𩾃鮺鲝鮿𫚚鯀鲧鯁鲠鯄𩾁鯆𫚙鯇鲩鯉鲤鯊鲨鯒鲬鯔鲻鯕鲯鯖鲭鯗鲞鯛鲷鯝鲴鯞𫚡鯡鲱鯢鲵鯤鲲鯧鲳鯨鲸鯪鲮鯫鲰鯬𫚞鯰鲶鯱𩾇鯴鲺鯶𩽼鯷鳀鯻𬶟鯽鲫鯾𫚣鯿鳊鰁鳈鰂鲗鰃鳂鰆䲠鰈鲽鰉鳇鰊𬶠鰋𫚢鰌䲡鰍鳅鰏鲾鰐鳄鰑𫚊鰒鳆鰓鳃鰕𫚥鰛鳁鰜鳒鰟鳑鰠鳋鰣鲥" +
  "鰤𫚕鰥鳏鰦𫚤鰧䲢鰨鳎鰩鳐鰫𫚦鰭鳍鰮鳁鰱鲢鰲鳌鰳鳓鰵鳘鰶𬶭鰷鲦鰹鲣鰺鲹鰻鳗鰼鳛鰽𫚧鰾鳔鱀𬶨鱂鳉鱄𫚋鱅鳙鱆𫠒鱇𩾌鱈鳕鱉鳖鱊𫚪鱒鳟鱔鳝鱖鳜鱗鳞鱘鲟鱚𬶮鱝鲼鱟鲎鱠鲙鱢𫚫鱣鳣鱤鳡鱧鳢鱨鲿鱭鲚鱮𫚈鱯鳠鱲𫚭鱷鳄鱸鲈鱺鲡鳥鸟鳧凫鳩鸠鳬凫鳲鸤鳳凤鳴鸣鳶鸢鳷𫛛" +
  "鳼𪉃鳽𫛚鳾䴓鴀𫛜鴃𫛞鴅𫛝鴆鸩鴇鸨鴉鸦鴐𫛤鴒鸰鴔𫛡鴕鸵鴗𫁡鴛鸳鴜𪉈鴝鸲鴞鸮鴟鸱鴣鸪鴥𫛣鴦鸯鴨鸭鴮𫛦鴯鸸鴰鸹鴲𪉆鴳𫛩鴴鸻鴷䴕鴻鸿鴽𫛪鴿鸽鵁䴔鵂鸺鵃鸼鵊𫛥鵏𬷕鵐鹀鵑鹃鵒鹆鵓鹁鵚𪉍鵜鹈鵝鹅鵟𫛭鵠鹄鵡鹉鵧𫛨鵩𫛳鵪鹌鵫𫛱鵬鹏鵮鹐鵯鹎鵰雕鵲鹊鵷鹓鵾鹍鶄䴖" +
  "鶇鸫鶉鹑鶊鹒鶌𫛵鶒𫛶鶓鹋鶖鹙鶗𫛸鶘鹕鶚鹗鶠𬸘鶡鹖鶥鹛鶦𫛷鶩鹜鶪䴗鶬鸧鶭𫛯鶯莺鶰𫛫鶱𬸣鶲鹟鶴鹤鶹鹠鶺鹡鶻鹘鶼鹣鶿鹚鷀鹚鷁鹢鷂鹞鷄鸡鷅𫛽鷉䴘鷊鹝鷐𫜀鷓鹧鷔𪉑鷖鹥鷗鸥鷙鸷鷚鹨鷟𬸦鷣𫜃鷤𫛴鷥鸶鷦鹪鷨𪉊鷩𫜁鷫鹔鷭𬸪鷯鹩鷲鹫鷳鹇鷴鹇鷷𫜄鷸鹬鷹鹰鷺鹭鷽鸴" +
  "鷿𬸯鸂㶉鸇鹯鸊䴙鸋𫛢鸌鹱鸏鹲鸑𬸚鸕鸬鸗𫛟鸘鹴鸚鹦鸛鹳鸝鹂鸞鸾鹵卤鹹咸鹺鹾鹼碱鹽盐麗丽麥麦麨𪎊麩麸麪面麫面麬𤿲麯曲麲𪎉麳𪎌麴曲麵面麷𫜑麼么麽么黃黄黌黉點点黨党黲黪黴霉黶黡黷黩黽黾黿鼋鼂鼌鼉鼍鼕冬鼴鼹齊齐齋斋齎赍齏齑齒齿齔龀齕龁齗龂齘𬹼齙龅齜龇" +
  "齟龃齠龆齡龄齣出齦龈齧啮齩𫜪齪龊齬龉齭𫜭齮𬺈齯𫠜齰𫜬齲龋齴𫜮齶腭齷龌齼𬺓齾𫜰龍龙龎厐龐庞龑䶮龓𫜲龔龚龕龛龜龟龭𩨎龯𨱆鿁䜤鿓鿒";

/** 繁体转简体（单字映射，未覆盖字符原样保留） */
export function t2s(text: string): string {
  let out = "";
  for (const ch of text) out += T2S_MAP.get(ch) ?? ch;
  return out;
}
const T2S_MAP = new Map<string, string>(
  // u 标志按码位配对：表里偶有扩展区字符（UTF-16 代理对），按码元切分会整表错位
  (T2S_PAIRS.match(/../gu) ?? []).map((pair) => {
    const [t, s] = [...pair];
    return [t, s] as [string, string];
  })
);

export type MatPlatform = "bili" | "xhs" | "douyin" | "web";

export interface TearFetchResult {
  /** 是否拿到有效内容（正文或逐字稿至少一项非占位） */
  ok: boolean;
  platform: MatPlatform;
  gots: { body: boolean; images: number; video: boolean; transcript: boolean };
  /** 人话摘要（进任务日志） */
  note: string;
}

export type StepFn = (step: string) => void;

// ===================== 平台识别与 id 提取（纯函数，可测） =====================

export function detectPlatform(url: string): MatPlatform {
  if (/bilibili\.com\/video\/(BV[0-9A-Za-z]+|av\d+)/i.test(url) || /b23\.tv\//i.test(url)) return "bili";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) return "xhs";
  if (/douyin\.com/i.test(url)) return "douyin";
  return "web";
}

export function bvidOf(url: string): string | null {
  const m = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i) || url.match(/(BV[0-9A-Za-z]{10})/);
  return m ? m[1] : null;
}

/** 小红书笔记 id：explore/<id>、discovery/item/<id>、短链跳转后的任意形态 */
export function xhsNoteId(url: string): string | null {
  const m =
    url.match(/\/explore\/([0-9a-f]+)/i) ||
    url.match(/\/discovery\/item\/([0-9a-f]+)/i) ||
    url.match(/[?&]note_id=([0-9a-f]+)/i) ||
    url.match(/\/note\/([0-9a-f]+)/i);
  return m ? m[1] : null;
}

/** 抖音视频 id：/video/<digits> */
export function douyinId(url: string): string | null {
  const m = url.match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

/** 页面内嵌 JSON 容错解析：undefined → null（只替换值位置的，避免破坏正文文本） */
export function parseEmbeddedJson<T = any>(raw: string): T | null {
  const cleaned = raw.replace(/([{,:[]\s*)undefined(?=\s*[,}\]])/g, "$1null");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/** 从小红书页面 HTML 提取 __INITIAL_STATE__ 里的笔记对象（纯函数，可测） */
export function extractXhsNote(html: string): any | null {
  const m =
    html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/) ||
    html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  const state = parseEmbeddedJson(m[1]);
  const note = state?.note?.noteDetailMap;
  if (!note || typeof note !== "object") return null;
  const first = Object.values<any>(note)[0]?.note ?? note.currentNoteId?.note;
  return first && (first.title || first.desc) ? first : null;
}

/** 笔记图片地址列表（urlDefault 优先，回退 infoList 末位原图） */
export function xhsImageUrls(note: any): string[] {
  const list = Array.isArray(note?.imageList) ? note.imageList : [];
  return list
    .map((img: any) => img?.urlDefault || (Array.isArray(img?.infoList) ? img.infoList[img.infoList.length - 1]?.url : "") || img?.url || "")
    .filter((u: string) => /^https?:\/\//.test(u));
}

// ===================== 通用网络与媒体工具 =====================

async function getText(url: string, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA_DESKTOP, "Accept-Language": "zh-CN,zh;q=0.9", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function downloadBin(url: string, dest: string, headers: Record<string, string> = {}, maxBytes = 320 * 1024 * 1024): Promise<number> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA_DESKTOP, ...headers },
    signal: AbortSignal.timeout(180000),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`文件过大（${(buf.length / 1048576).toFixed(0)}MB）`);
  writeFileSync(dest, buf);
  return buf.length;
}

/** webp/avif 转 jpg（macOS sips）；转换失败或本就是 jpg/png 则原样保留 */
async function ensureJpg(file: string): Promise<string> {
  const ext = path.extname(file).toLowerCase();
  if ([".jpg", ".jpeg", ".png"].includes(ext)) return file;
  const out = file.replace(/\.[^.]+$/, ".jpg");
  try {
    await execFileP("/usr/bin/sips", ["-s", "format", "jpeg", file, "--out", out]);
    return out;
  } catch {
    return file;
  }
}

/** 视频抽 16k 单声道 wav；长音频直接切段（段间并发转写更快） */
async function extractAudioSegments(videoFile: string, segSeconds: number): Promise<string[]> {
  const base = videoFile.replace(/\.[^.]+$/, "");
  if (segSeconds > 0) {
    await execFileP("/opt/homebrew/bin/ffmpeg", [
      "-y", "-i", videoFile, "-vn", "-ar", "16000", "-ac", "1",
      "-f", "segment", "-segment_time", String(segSeconds), `${base}_%02d.wav`,
    ]);
    const segs = ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"]
      .map((i) => `${base}_${i}.wav`)
      .filter((f) => existsSync(f));
    if (segs.length > 1) return segs;
  }
  const single = `${base}.wav`;
  await execFileP("/opt/homebrew/bin/ffmpeg", ["-y", "-i", videoFile, "-vn", "-ar", "16000", "-ac", "1", single]);
  return [single];
}

/** 调本机 whisper server 转写一个 wav；server 不在线/失败返回 null（不编造） */
export async function whisperTranscribe(wavFile: string): Promise<string | null> {
  const buf = readFileSync(wavFile);
  const fd = new FormData();
  fd.append("file", new Blob([buf]), path.basename(wavFile));
  fd.append("model", "whisper-1");
  fd.append("language", "zh");
  try {
    const res = await fetch(WHISPER_ENDPOINT, { method: "POST", body: fd, signal: AbortSignal.timeout(600000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    const text = typeof j?.text === "string" ? j.text.trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

/** 视频 → 音频切段 → 并发转写 → 拼接全文 */
async function transcribeVideo(dir: string, videoFile: string, durationSec: number, onStep: StepFn): Promise<string | null> {
  onStep("提取音频并调用本机 whisper 转写…");
  const segSeconds = durationSec > 480 ? 240 : 0;
  let segs: string[];
  try {
    segs = await extractAudioSegments(videoFile, segSeconds);
  } catch {
    return null;
  }
  const texts = new Array<string | null>(segs.length).fill(null);
  const workers = 2;
  let next = 0;
  async function runWorker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= segs.length) return;
      onStep(`whisper 转写中（${i + 1}/${segs.length} 段）…`);
      texts[i] = await whisperTranscribe(segs[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, segs.length) }, runWorker));
  void dir;
  const full = texts.filter((t): t is string => !!t).join("\n").trim();
  // whisper 中文输出偏繁体（base 模型），统一转简体再归档
  return full ? t2s(full) : null;
}

// ===================== 平台抓取实现 =====================

interface RawMeta {
  title: string;
  author: string;
  /** 正文/简介全文（图文笔记是正文，视频是简介） */
  desc: string;
  metaLines: string[];
  imageUrls: string[];
  videoUrl?: string;
  videoDurationSec?: number;
}

async function fetchBili(url: string): Promise<RawMeta> {
  const bvid = bvidOf(url);
  if (!bvid) throw new Error("无法从链接提取 BV 号");
  const view: any = await getText(
    `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`,
    { Referer: "https://www.bilibili.com/", Accept: "application/json" }
  );
  const data = JSON.parse(view)?.data;
  if (!data?.cid) throw new Error("view 接口未返回有效数据");
  const stat = data.stat ?? {};
  // html5 端点拿渐进式 mp4（免登录、低清够转写用）；失败再降一档清晰度
  let videoUrl: string | undefined;
  for (const q of ["64", "16"]) {
    try {
      const play: any = await getText(
        `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${data.cid}&qn=${q}&fnval=1&platform=html5&high_quality=${q === "64" ? 1 : 0}`,
        { Referer: "https://www.bilibili.com/", Accept: "application/json" }
      );
      const durl = JSON.parse(play)?.data?.durl;
      if (Array.isArray(durl) && durl.length && durl[0].url) {
        videoUrl = durl[0].url;
        break;
      }
    } catch { /* 降档重试 */ }
  }
  return {
    title: data.title ?? "",
    author: data.owner?.name ?? "",
    desc: data.desc ?? "",
    metaLines: [
      "- 平台：Bilibili",
      `- 作者：${data.owner?.name ?? "?"}`,
      `- 链接：${url}`,
      `- BV号：${bvid}`,
      `- 时长：${data.duration ?? "?"} 秒`,
      `- 数据：播放 ${stat.view ?? "?"} / 点赞 ${stat.like ?? "?"} / 收藏 ${stat.favorite ?? "?"} / 投币 ${stat.coin ?? "?"} / 弹幕 ${stat.danmaku ?? "?"} / 评论 ${stat.reply ?? "?"}`,
    ],
    imageUrls: data.pic ? [data.pic] : [],
    videoUrl,
    videoDurationSec: typeof data.duration === "number" ? data.duration : undefined,
  };
}

async function fetchXhs(url: string): Promise<RawMeta> {
  // 短链/带 token 链接统一跟随跳转拿最终地址与笔记 id
  const pageUrl = /xhslink\.com/i.test(url)
    ? (await fetch(url, { headers: { "User-Agent": UA_IPHONE }, signal: AbortSignal.timeout(20000), redirect: "follow" })).url
    : url;
  const noteId = xhsNoteId(pageUrl);
  // 直访笔记页必须带上原链接的查询参数（xsec_token 等，丢掉会被反爬拦截）。
  // 首选「原链接 + 桌面 UA」：与素材收录快速通道同一路径，实测最稳；
  // 拿不到笔记数据再退「discovery 端点 + iPhone UA」（带齐查询参数）。
  const qs = pageUrl.indexOf("?") >= 0 ? pageUrl.slice(pageUrl.indexOf("?")) : "";
  const attempts: Array<[string, Record<string, string>]> = [
    [pageUrl, {}],
    [noteId ? `https://www.xiaohongshu.com/discovery/item/${noteId}${qs}` : pageUrl, { "User-Agent": UA_IPHONE, Referer: "https://www.xiaohongshu.com/" }],
  ];
  let note: any = null;
  let lastErr = "";
  for (const [target, headers] of attempts) {
    try {
      const html = await getText(target, headers); // 不传 UA 时 getText 默认桌面 UA
      note = extractXhsNote(html);
      if (note) break;
      lastErr = "页面无笔记数据";
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }
  if (!note) throw new Error(`页面未解析出笔记数据（可能被反爬拦截）：${lastErr}`);
  const interact = note.interactInfo ?? {};
  const stream = note.video?.media?.stream ?? {};
  const videoUrl = stream.h264?.[0]?.masterUrl || stream.h265?.[0]?.masterUrl || stream.clone?.[0]?.masterUrl;
  return {
    title: note.title ?? "",
    author: note.user?.nickname ?? "",
    desc: note.desc ?? "",
    metaLines: [
      "- 平台：小红书（笔记）",
      `- 作者：${note.user?.nickname ?? "?"}`,
      `- 链接：${url}`,
      `- 类型：${note.type === "video" ? "视频" : "图文"}`,
      `- 数据：点赞 ${interact.liked ?? "?"} / 收藏 ${interact.collected ?? "?"} / 评论 ${interact.comment ?? "?"}`,
    ],
    imageUrls: xhsImageUrls(note).slice(0, 12),
    videoUrl: note.type === "video" ? videoUrl : undefined,
  };
}

async function fetchDouyin(url: string): Promise<RawMeta> {
  const finalUrl = /v\.douyin\.com/i.test(url)
    ? (await fetch(url, { headers: { "User-Agent": UA_IPHONE }, signal: AbortSignal.timeout(20000), redirect: "follow" })).url
    : url;
  const vid = douyinId(finalUrl);
  if (!vid) throw new Error("无法提取抖音视频 id");
  const html = await getText(`https://www.iesdouyin.com/share/video/${vid}`, { "User-Agent": UA_IPHONE });
  const m = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  const router = m ? parseEmbeddedJson(m[1]) : null;
  const item =
    router?.loaderData?.[`video_(id)/page`]?.videoInfoRes?.item_list?.[0] ??
    Object.values<any>(router?.loaderData ?? {})[0]?.videoInfoRes?.item_list?.[0];
  if (!item) throw new Error("页面未解析出视频数据（可能被反爬拦截）");
  const playUri = item.video?.play_addr?.uri;
  return {
    title: item.desc ?? "",
    author: item.author?.nickname ?? "",
    desc: item.desc ?? "",
    metaLines: [
      "- 平台：抖音（视频）",
      `- 作者：${item.author?.nickname ?? "?"}`,
      `- 链接：${url}`,
      `- 数据：点赞 ${item.statistics?.digg_count ?? "?"} / 评论 ${item.statistics?.comment_count ?? "?"}`,
    ],
    imageUrls: [],
    videoUrl: playUri ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${playUri}` : undefined,
  };
}

/** 兜底：普通网页，title + og:description + 正文文本粗提 */
async function fetchWeb(url: string): Promise<RawMeta> {
  const html = await getText(url);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const desc =
    html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)/i)?.[1] ?? "";
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);
  if (title.length + desc.length + text.length < 80) throw new Error("页面文本过少");
  return {
    title,
    author: "",
    desc: [desc, text].filter(Boolean).join("\n\n"),
    metaLines: ["- 平台：网页", `- 链接：${url}`],
    imageUrls: [],
  };
}

// ===================== 主入口 =====================

/**
 * 抓取一条素材的全部原文并归档到 dir。幂等：dir 已有可用归档（正文非占位或有逐字稿）
 * 直接复用；只有占位残留（历史半成品）时清掉重抓。
 */
export async function fetchMaterialRaw(url: string, dir: string, onStep: StepFn = () => {}): Promise<TearFetchResult> {
  const platform = detectPlatform(url);
  const gots = { body: false, images: 0, video: false, transcript: false };
  mkdirSync(path.join(dir, "图片"), { recursive: true });

  // 幂等检查：已有可用归档就不重复下载
  const bodyPath = path.join(dir, "正文.md");
  const scriptPath = path.join(dir, "逐字稿.md");
  if (existsSync(scriptPath) || (existsSync(bodyPath) && readFileSync(bodyPath, "utf8").length > 400)) {
    return {
      ok: true,
      platform,
      gots: { body: existsSync(bodyPath), images: 0, video: existsSync(scriptPath), transcript: existsSync(scriptPath) },
      note: "原文库已有可用归档，跳过抓取",
    };
  }
  // 历史半成品（占位正文且无逐字稿）→ 清掉本次管理的文件重抓
  if (existsSync(bodyPath)) rmSync(bodyPath);

  let meta: RawMeta;
  try {
    onStep(`后端直连抓取 ${platform} 素材信息…`);
    meta = await (platform === "bili" ? fetchBili(url) : platform === "xhs" ? fetchXhs(url) : platform === "douyin" ? fetchDouyin(url) : fetchWeb(url));
  } catch (e: any) {
    return { ok: false, platform, gots, note: `抓取失败：${e?.message ?? e}` };
  }

  // 正文/图文正文先落盘（视频的正文=简介，脚本以逐字稿为准）
  const bodyMd = [
    `# ${meta.title || "(无标题)"}`,
    "",
    ...meta.metaLines,
    "",
    platform === "bili" ? "## 视频简介（UP主文案）" : "## 正文",
    "",
    meta.desc?.trim() || "（无文字内容）",
  ].join("\n");
  writeFileSync(bodyPath, bodyMd);
  gots.body = (meta.desc ?? "").trim().length > 0;

  // 图片与视频并行下载；视频下载完就地转写
  const jobs: Promise<void>[] = [];
  if (meta.imageUrls.length) {
    jobs.push(
      (async () => {
        onStep(`下载图片（${meta.imageUrls.length} 张）…`);
        for (let i = 0; i < meta.imageUrls.length; i++) {
          try {
            const raw = path.join(dir, "图片", `img_${i + 1}${path.extname(new URL(meta.imageUrls[i]).pathname) || ""}`);
            await downloadBin(meta.imageUrls[i], raw, { Referer: "https://" + new URL(meta.imageUrls[i]).hostname + "/" }, 40 * 1024 * 1024);
            await ensureJpg(raw);
            gots.images++;
          } catch { /* 单图失败跳过，不编造 */ }
        }
      })()
    );
  }
  let transcript: string | null = null;
  const videoUrl = meta.videoUrl;
  if (videoUrl) {
    jobs.push(
      (async () => {
        try {
          onStep("下载视频…");
          const videoFile = path.join(dir, "视频.mp4");
          const size = await downloadBin(videoUrl, videoFile, platform === "bili" ? { Referer: "https://www.bilibili.com/" } : {}, 320 * 1024 * 1024);
          gots.video = true;
          transcript = await transcribeVideo(dir, videoFile, meta.videoDurationSec ?? 0, onStep);
          if (transcript) {
            writeFileSync(scriptPath, transcript);
            gots.transcript = true;
          }
          void size;
        } catch (e: any) {
          onStep(`视频处理失败（${e?.message ?? e}），跳过逐字稿`);
        }
      })()
    );
  }
  await Promise.all(jobs);

  const ok = gots.body || gots.transcript;
  const parts = [
    gots.body ? "正文" : "",
    gots.images ? `${gots.images} 图` : "",
    gots.video ? "视频" : "",
    gots.transcript ? `逐字稿 ${Math.round((transcript ?? "").length / 1024)}KB` : "",
  ].filter(Boolean);
  return {
    ok,
    platform,
    gots,
    note: ok ? `${platform}：${parts.join(" + ")}` : `${platform}：未获得有效内容`,
  };
}
