// i18n.js — Qatrol Coin multilanguage support (RU / EN)
// Usage:
//   HTML:  <span data-i18n="key"></span>
//   JS:    T('key')
//   Lang toggle: fixed golden button bottom-right + injected into .nav

(function() {
  const STORAGE_KEY = 'qtr_lang';

  const translations = {
    // ── Navigation ────────────────────────────────────────────────────────────
    'nav.home':        { ru: 'Главная',    en: 'Home' },
    'nav.wallet':      { ru: 'Кошелёк',   en: 'Wallet' },
    'nav.stats':       { ru: 'Статистика',en: 'Stats' },
    'nav.richlist':    { ru: 'Rich List',  en: 'Rich List' },
    'nav.status':      { ru: 'Статус',     en: 'Status' },
    'nav.login':       { ru: 'Войти',      en: 'Login' },

    // ── Common ────────────────────────────────────────────────────────────────
    'common.loading':  { ru: '⏳ Загрузка...', en: '⏳ Loading...' },
    'common.refresh':  { ru: '↻ Обновить',     en: '↻ Refresh' },
    'common.copy':     { ru: 'Копировать',      en: 'Copy' },
    'common.copied':   { ru: 'Скопировано!',    en: 'Copied!' },
    'common.explorer': { ru: 'Открыть обозреватель →', en: 'Open Explorer →' },
    'common.unavailable': { ru: 'Недоступно', en: 'Unavailable' },
    'common.checking': { ru: 'Проверка...', en: 'Checking...' },
    'common.ok':       { ru: 'Работает',    en: 'Online' },
    'common.error':    { ru: 'Ошибка',      en: 'Error' },
    'common.timeout':  { ru: 'Таймаут',     en: 'Timeout' },
    'common.updated':  { ru: 'Обновлено',   en: 'Updated' },

    // ── Time units ────────────────────────────────────────────────────────────
    'time.sec':        { ru: 'с',      en: 's' },
    'time.min':        { ru: 'м',      en: 'm' },
    'time.hour':       { ru: 'ч',      en: 'h' },
    'time.day':        { ru: 'д',      en: 'd' },
    'time.ago':        { ru: 'назад',  en: 'ago' },
    'time.locale':     { ru: 'ru',     en: 'en' },
    'time.tx_abbr':    { ru: 'тр',     en: 'tx' },
    'time.txs_abbr':   { ru: 'тр.',    en: 'tx' },

    // ── Stats page ────────────────────────────────────────────────────────────
    'stats.label':     { ru: '◆ Аналитика',      en: '◆ Analytics' },
    'stats.title':     { ru: 'Статистика',        en: 'Network' },
    'stats.title2':    { ru: 'сети',              en: 'Stats' },
    'stats.blocks':    { ru: 'Блоков',            en: 'Blocks' },
    'stats.hashrate':  { ru: 'Хэшрейт (расч.)',   en: 'Hashrate (est.)' },
    'stats.diff':      { ru: 'Сложность',         en: 'Difficulty' },
    'stats.avgtime':   { ru: 'Ср. блок',          en: 'Avg block' },
    'stats.txs':       { ru: 'Транзакций',        en: 'Transactions' },
    'stats.circ':      { ru: 'В обращении',       en: 'Circulating' },
    'stats.workers':   { ru: 'Активных майнеров', en: 'Active miners' },
    'stats.realhash':  { ru: 'Реальный хэшрейт пула', en: 'Pool hashrate' },
    'stats.shares':    { ru: 'Шар принято',       en: 'Shares accepted' },
    'stats.poolblocks':{ ru: 'Блоков найдено пулом', en: 'Pool blocks found' },
    'stats.lastpool':  { ru: 'Последний блок пула', en: 'Last pool block' },
    'stats.mempool':   { ru: 'В mempool',          en: 'In mempool' },
    'stats.chart.hash':   { ru: '⚡ Хэшрейт сети',      en: '⚡ Network Hashrate' },
    'stats.chart.diff':   { ru: '🎯 Сложность',          en: '🎯 Difficulty' },
    'stats.chart.time':   { ru: '⏱ Время блока (сек)',   en: '⏱ Block time (sec)' },
    'stats.chart.tx':     { ru: '📦 Транзакций в блоке', en: '📦 Txs per block' },
    'stats.chart.last60': { ru: 'Последние 60 блоков',   en: 'Last 60 blocks' },
    'stats.recent':    { ru: 'Последние блоки',   en: 'Recent Blocks' },
    'stats.col.block': { ru: 'Блок',   en: 'Block' },
    'stats.col.hash':  { ru: 'Хэш',    en: 'Hash' },
    'stats.col.txs':   { ru: 'Тр-ций', en: 'Txs' },
    'stats.col.diff':  { ru: 'Сложность', en: 'Diff' },
    'stats.col.time':  { ru: 'Время',  en: 'Time' },
    'stats.col.age':   { ru: 'Возраст',en: 'Age' },

    // ── Status page ───────────────────────────────────────────────────────────
    'status.label':    { ru: '◆ Мониторинг',   en: '◆ Monitoring' },
    'status.title':    { ru: 'Статус',          en: 'Network' },
    'status.title2':   { ru: 'сети',            en: 'Status' },
    'status.sub':      { ru: 'Состояние всех сервисов Qatrol Coin в реальном времени.', en: 'Live status of all Qatrol Coin services.' },
    'status.checking': { ru: 'Проверяем...',    en: 'Checking...' },
    'status.connecting':{ ru: 'Соединение с сервисами', en: 'Connecting to services' },
    'status.ok':       { ru: 'Все системы работают', en: 'All systems operational' },
    'status.ok_sub':   { ru: 'Нода, пул и веб-сервер доступны', en: 'Node, pool and web server are online' },
    'status.issues':   { ru: 'Обнаружены проблемы',    en: 'Issues detected' },
    'status.issues_sub':{ ru: 'Один или несколько сервисов недоступны', en: 'One or more services are down' },
    'status.svc_ok':   { ru: '✓ Работает',      en: '✓ Online' },
    'status.svc_bad':  { ru: '✗ Недоступно',    en: '✗ Unavailable' },
    'status.chain_ok': { ru: '✓ Валидна',        en: '✓ Valid' },
    'status.chain_bad':{ ru: '✗ Нарушена',       en: '✗ Broken' },
    'status.ms':       { ru: 'мс',               en: 'ms' },
    'status.node':     { ru: 'Нода / API',      en: 'Node / API' },
    'status.node_desc':{ ru: 'Блокчейн, транзакции, кошельки · порт 3001', en: 'Blockchain, transactions, wallets · port 3001' },
    'status.pool':     { ru: 'Майнинг-пул',     en: 'Mining Pool' },
    'status.pool_desc':{ ru: 'Распределение заданий, выплаты · порт 3002', en: 'Job distribution, payouts · port 3002' },
    'status.web':      { ru: 'Веб-сервер',      en: 'Web Server' },
    'status.web_desc': { ru: 'Сайт, кошелёк, обозреватель · порт 3000', en: 'Website, wallet, explorer · port 3000' },
    'status.chain':    { ru: 'Целостность цепи', en: 'Chain Integrity' },
    'status.chain_desc':{ ru: 'Валидация всех блоков и транзакций', en: 'Validation of all blocks and transactions' },
    'status.node_section': { ru: '⛓ Нода',     en: '⛓ Node' },
    'status.pool_section': { ru: '🏊 Пул',      en: '🏊 Pool' },
    'status.uptime':   { ru: 'Аптайм ноды',     en: 'Node uptime' },
    'status.blocks':   { ru: 'Блоков в цепи',   en: 'Blocks in chain' },
    'status.lastblock':{ ru: 'Последний блок',   en: 'Last block' },
    'status.pending':  { ru: 'В mempool',        en: 'In mempool' },
    'status.diff':     { ru: 'Сложность',        en: 'Difficulty' },
    'status.hashrate': { ru: 'Хэшрейт (расч.)', en: 'Hashrate (est.)' },
    'status.workers':  { ru: 'Активных майнеров',en: 'Active miners' },
    'status.realhash': { ru: 'Реальный хэшрейт', en: 'Real hashrate' },
    'status.shares':   { ru: 'Шар принято',      en: 'Shares accepted' },
    'status.found':    { ru: 'Блоков найдено',   en: 'Blocks found' },
    'status.rejected': { ru: 'Блоков отклонено', en: 'Blocks rejected' },
    'status.lastpoolblock': { ru: 'Последний блок пула', en: 'Last pool block' },
    'status.history':  { ru: 'История доступности', en: 'Uptime history' },
    'status.history_sub': { ru: 'Последние 30 проверок', en: 'Last 30 checks' },
    'status.uptime_ago': { ru: '30 проверок назад', en: '30 checks ago' },
    'status.uptime_now': { ru: 'Сейчас',          en: 'Now' },
    'status.refresh_hint': { ru: 'Обновление каждые 30 секунд', en: 'Updates every 30 seconds' },
    'status.last_check': { ru: 'Последняя проверка:', en: 'Last check:' },
    'status.next_check': { ru: 'Следующая через 30с', en: 'Next in 30s' },
    'status.no_data':  { ru: 'Нет данных',   en: 'No data' },

    // ── Rich List page ────────────────────────────────────────────────────────
    'rl.label':        { ru: '◆ Держатели',   en: '◆ Holders' },
    'rl.title':        { ru: 'Rich List',      en: 'Rich List' },
    'rl.sub':          { ru: 'Топ-50 адресов по балансу. Обновляется в реальном времени.', en: 'Top-50 addresses by balance. Updates in real time.' },
    'rl.total':        { ru: 'Всего в обращении', en: 'Total circulating' },
    'rl.wallets':      { ru: 'Всего адресов',  en: 'Total addresses' },
    'rl.top1':         { ru: 'Доля топ-1',     en: 'Top-1 share' },
    'rl.top10':        { ru: 'Доля топ-10',    en: 'Top-10 share' },
    'rl.gini':         { ru: 'Коэффициент Джини', en: 'Gini Coefficient' },
    'rl.gini_hint':    { ru: '0 = полное равенство · 1 = монополия', en: '0 = full equality · 1 = monopoly' },
    'rl.nakamoto':     { ru: 'Коэффициент Накамото', en: 'Nakamoto Coefficient' },
    'rl.nakamoto_hint':{ ru: 'мин. кол-во держателей для 51% монет', en: 'min holders needed for 51% of supply' },
    'rl.top50':        { ru: 'Доля топ-50',    en: 'Top-50 share' },
    'rl.top50_hint':   { ru: 'процент монет у топ-50 адресов', en: 'share of top-50 addresses' },
    'rl.col.rank':     { ru: '#',              en: '#' },
    'rl.col.address':  { ru: 'Адрес',          en: 'Address' },
    'rl.col.balance':  { ru: 'Баланс QTR',     en: 'Balance QTR' },
    'rl.col.share':    { ru: 'Доля',           en: 'Share' },
    'rl.col.bar':      { ru: 'Распределение',  en: 'Distribution' },
    'rl.copy':         { ru: 'копировать',     en: 'copy' },
    'rl.copied':       { ru: 'скопировано',    en: 'copied' },
    'rl.no_data':      { ru: 'Нет данных',     en: 'No data' },
    'rl.node_unavail': { ru: 'Нода недоступна', en: 'Node unavailable' },

    // ── Login / Wallet page ───────────────────────────────────────────────────
    'login.back':      { ru: '← На главную',   en: '← Back to home' },
    'login.tab':       { ru: 'Войти',           en: 'Login' },
    'login.register':  { ru: 'Создать',         en: 'Create' },
    'login.import':    { ru: 'Импорт',          en: 'Import' },
    'login.mnemonic':  { ru: 'Мнемоник',        en: 'Mnemonic' },
    'login.address':   { ru: 'Адрес кошелька',  en: 'Wallet address' },
    'login.password':  { ru: 'Пароль',          en: 'Password' },
    'login.btn':       { ru: 'Войти',           en: 'Login' },
    'login.addr_ph':   { ru: 'K...',            en: 'K...' },
    'login.pass_ph':   { ru: '••••••••',        en: '••••••••' },
    'login.label_name':{ ru: 'Название',        en: 'Label' },
    'login.label_ph':  { ru: 'Основной кошелёк...', en: 'Main wallet...' },
    'login.label_pass':{ ru: 'Пароль (мин. 6 символов)', en: 'Password (min 6 chars)' },
    'login.label_pass2':{ ru: 'Повтор пароля',  en: 'Repeat password' },
    'login.reg_pass_ph':{ ru: 'Придумайте пароль', en: 'Create password' },
    'login.reg_pass2_ph':{ ru: 'Повторите',     en: 'Repeat it' },
    'login.create_btn':{ ru: 'Создать кошелёк', en: 'Create Wallet' },
    'login.reg_info':  { ru: 'Будет создан кошелёк с мнемоником из 12 слов и ECDSA ключами.', en: 'A wallet with a 12-word mnemonic and ECDSA keys will be created.' },
    'login.created':   { ru: '✓ Кошелёк создан!', en: '✓ Wallet created!' },
    'login.save_warn': { ru: '⚠️ Сохрани мнемоник — единственный способ восстановить кошелёк!', en: '⚠️ Save your mnemonic — the only way to recover your wallet!' },
    'login.addr_label':{ ru: 'Адрес',           en: 'Address' },
    'login.mnem_label':{ ru: 'Мнемоник (12 слов)', en: 'Mnemonic (12 words)' },
    'login.privkey_label':{ ru: 'Приватный ключ', en: 'Private key' },
    'login.open_wallet':{ ru: 'Открыть кошелёк →', en: 'Open Wallet →' },
    'login.privkey_label2':{ ru: 'Приватный ключ (64 hex)', en: 'Private key (64 hex)' },
    'login.privkey_ph':{ ru: 'a3f4...',          en: 'a3f4...' },
    'login.new_pass':  { ru: 'Новый пароль',     en: 'New password' },
    'login.set_pass_ph':{ ru: 'Установите пароль', en: 'Set a password' },
    'login.imp_label_ph':{ ru: 'Мой кошелёк...', en: 'My wallet...' },
    'login.import_btn':{ ru: 'Импортировать',    en: 'Import' },
    'login.mn_info':   { ru: 'Восстановление по 12 словам BIP-39. Введи слова через пробел.', en: 'Recovery by 12 BIP-39 words. Enter words separated by spaces.' },
    'login.mn_words':  { ru: '12 слов мнемоника', en: '12 mnemonic words' },
    'login.mn_label_ph':{ ru: 'Восстановленный...', en: 'Recovered...' },
    'login.restore_btn':{ ru: 'Восстановить',    en: 'Restore' },
    'login.checking_node':{ ru: 'проверка ноды...', en: 'checking node...' },

    // ── Landing page ──────────────────────────────────────────────────────────
    'land.nav.mining':  { ru: 'Майнинг',        en: 'Mining' },
    'land.nav.about':   { ru: 'О проекте',       en: 'About' },
    'land.create_wallet':{ ru: 'Создать кошелёк', en: 'Create Wallet' },

    'land.mob.how':     { ru: 'Как начать',      en: 'How to start' },
    'land.mob.features':{ ru: 'Возможности',     en: 'Features' },
    'land.mob.blockchain':{ ru: 'Блокчейн',      en: 'Blockchain' },
    'land.mob.tg':      { ru: '📢 Telegram канал', en: '📢 Telegram channel' },
    'land.mob.login':   { ru: '🔑 Войти',        en: '🔑 Login' },
    'land.mob.create':  { ru: '✨ Создать кошелёк', en: '✨ Create Wallet' },

    'land.hero.badge':  { ru: 'Сеть активна · QTR v1.0', en: 'Network live · QTR v1.0' },
    'land.hero.sub':    { ru: 'Криптовалюта, которую можно добыть прямо сейчас.\nНикакого оборудования — просто скачай майнер и начни.', en: 'A cryptocurrency you can mine right now.\nNo equipment needed — just download the miner and start.' },
    'land.hero.btn_create': { ru: '✦ Создать кошелёк', en: '✦ Create Wallet' },
    'land.hero.btn_mine':   { ru: '⛏ Как майнить',    en: '⛏ How to mine' },
    'land.hero.stat_blocks':{ ru: 'Блоков',            en: 'Blocks' },
    'land.hero.stat_reward':{ ru: 'QTR за блок',       en: 'QTR per block' },
    'land.hero.stat_supply':{ ru: 'Эмиссия',           en: 'Supply' },
    'land.hero.stat_fee':   { ru: 'Комиссия',          en: 'Fee' },

    'land.live.blocks': { ru: 'Блоков',          en: 'Blocks' },
    'land.live.hashrate':{ ru: 'Хэшрейт',        en: 'Hashrate' },
    'land.live.diff':   { ru: 'Сложность',        en: 'Difficulty' },
    'land.live.mempool':{ ru: 'В mempool',         en: 'In mempool' },
    'land.live.circ':   { ru: 'В обращении',      en: 'Circulating' },

    'land.how.label':   { ru: '◆ Простой старт', en: '◆ Quick Start' },
    'land.how.title':   { ru: 'Три шага до<br><span style="color:var(--gold)">первых монет</span>', en: 'Three steps to<br><span style="color:var(--gold)">your first coins</span>' },
    'land.how.sub':     { ru: 'Не нужны специальные знания. Работает на любом Windows-ПК.', en: 'No special knowledge required. Works on any Windows PC.' },

    'land.step1.title': { ru: 'Создай кошелёк',  en: 'Create a wallet' },
    'land.step1.sub':   { ru: 'Зарегистрируйся прямо здесь — адрес, приватный ключ и мнемоник из 12 слов генерируются мгновенно. Никаких email, никакой верификации.', en: 'Register right here — address, private key and 12-word mnemonic generated instantly. No email, no verification.' },
    'land.step1.time':  { ru: '⚡ 30 секунд',    en: '⚡ 30 seconds' },

    'land.step2.title': { ru: 'Скачай майнер',   en: 'Download miner' },
    'land.step2.sub':   { ru: 'Один .exe файл. Адрес пула уже встроен внутрь. Запустил, ввёл адрес кошелька — всё. Работает в фоне, не мешает другим задачам.', en: 'One .exe file. Pool address is already built in. Launch it, enter your wallet address — done. Runs in background.' },
    'land.step2.time':  { ru: '📥 Один клик',    en: '📥 One click' },

    'land.step3.title': { ru: 'Получай QTR',     en: 'Earn QTR' },
    'land.step3.sub':   { ru: 'Майнер находит блоки и отправляет монеты прямо на твой кошелёк через пул. Каждый блок — 16.7 QTR. Следи за балансом в Telegram боте или на сайте.', en: 'The miner finds blocks and sends coins directly to your wallet via the pool. Each block — 16.7 QTR. Track balance in the Telegram bot or website.' },
    'land.step3.time':  { ru: '💰 16.7 QTR / блок', en: '💰 16.7 QTR / block' },

    'land.feat.label':  { ru: '◆ Технологии',   en: '◆ Technology' },
    'land.feat.title':  { ru: 'Почему<br><span style="color:var(--gold)">Qatrol Coin?</span>', en: 'Why<br><span style="color:var(--gold)">Qatrol Coin?</span>' },
    'land.feat.sub':    { ru: 'Настоящий блокчейн с открытым кодом, без посредников и маркетинговых обещаний.', en: 'A real open-source blockchain, without middlemen or marketing promises.' },

    'land.feat1.sub':   { ru: 'Те же алгоритмы что в Bitcoin. Proof-of-Work майнинг, подписи P-256, BIP-39 мнемоники.', en: 'Same algorithms as Bitcoin. Proof-of-Work mining, P-256 signatures, BIP-39 mnemonics.' },
    'land.feat2.title': { ru: 'Фиксированная эмиссия', en: 'Fixed Supply' },
    'land.feat2.sub':   { ru: 'Ровно 1,000,000,000 QTR навсегда. Никакой инфляции. Никакого допечатывания.', en: 'Exactly 1,000,000,000 QTR forever. No inflation. No additional minting.' },
    'land.feat3.title': { ru: 'Майнинг на ПК',  en: 'PC Mining' },
    'land.feat3.sub':   { ru: 'Не нужны ASIC и видеокарты. CPU-майнинг через пул. Пул автоматически распределяет награды.', en: 'No ASIC or GPU required. CPU mining via pool. Pool automatically distributes rewards.' },
    'land.feat4.sub':   { ru: 'Управляй кошельком прямо в Telegram. Переводы, баланс, статистика — всё через @QatrolCoinBot.', en: 'Manage your wallet directly in Telegram. Transfers, balance, stats — all via @QatrolCoinBot.' },
    'land.feat5.title': { ru: 'Открытый блокчейн', en: 'Open Blockchain' },
    'land.feat5.sub':   { ru: 'Каждая транзакция публична и проверяема. Обозреватель блоков доступен всем без регистрации.', en: 'Every transaction is public and verifiable. Block explorer is open to all without registration.' },
    'land.feat6.title': { ru: 'Минимальные комиссии', en: 'Minimal Fees' },
    'land.feat6.sub':   { ru: '0.1% от суммы перевода, минимум 0.0001 QTR. Переводить 100 QTR стоит всего 0.1 QTR.', en: '0.1% of transfer amount, minimum 0.0001 QTR. Sending 100 QTR costs just 0.1 QTR.' },

    'land.blocks.title':{ ru: 'Последние блоки', en: 'Recent Blocks' },
    'land.blocks.empty':{ ru: 'Нода недоступна или блоков пока нет', en: 'Node unavailable or no blocks yet' },

    'land.tknm.label':  { ru: '◆ Токеномика',   en: '◆ Tokenomics' },
    'land.tknm.title':  { ru: 'Распределение<br><span style="color:var(--gold)">1 000 000 000 QTR</span>', en: 'Distribution of<br><span style="color:var(--gold)">1 000 000 000 QTR</span>' },
    'land.tknm.sub':    { ru: 'Вся эмиссия зафиксирована в genesis-блоке. Никакой предпродажи, никаких приватных раундов.', en: 'All supply is fixed in the genesis block. No presale, no private rounds.' },
    'land.tknm.bar1':   { ru: '⛏ Майнинговые награды', en: '⛏ Mining Rewards' },
    'land.tknm.bar1_desc':{ ru: 'Распределяется майнерам по 16.7 QTR за блок', en: 'Distributed to miners at 16.7 QTR per block' },
    'land.tknm.bar2':   { ru: '🌐 Genesis-резерв', en: '🌐 Genesis Reserve' },
    'land.tknm.bar2_desc':{ ru: 'Резерв для ликвидности и листинга на биржах', en: 'Reserve for liquidity and exchange listings' },
    'land.tknm.bar3':   { ru: '💸 Комиссии пула', en: '💸 Pool Fees' },
    'land.tknm.bar3_desc':{ ru: 'Операционные расходы сети и пула', en: 'Network and pool operating costs' },
    'land.tknm.stat1_lbl':{ ru: 'Максимальная эмиссия QTR — навсегда', en: 'Max QTR supply — forever' },
    'land.tknm.stat2_lbl':{ ru: 'Награда за каждый найденный блок', en: 'Reward per block found' },
    'land.tknm.stat3_lbl':{ ru: 'QTR уже добыто (в обращении)', en: 'QTR mined so far (circulating)' },

    'land.calc.label':  { ru: '◆ Доходность',   en: '◆ Profitability' },
    'land.calc.title':  { ru: 'Калькулятор<br><span style="color:var(--gold)">майнинга</span>', en: 'Mining<br><span style="color:var(--gold)">Calculator</span>' },
    'land.calc.sub':    { ru: 'Сколько QTR ты заработаешь за день, неделю и месяц?', en: 'How much QTR will you earn per day, week and month?' },
    'land.calc.cores':  { ru: 'Ядер CPU',        en: 'CPU Cores' },
    'land.calc.speed':  { ru: 'Хэшрейт на ядро', en: 'Hashrate per core' },
    'land.calc.nethash':{ ru: 'Сетевой хэшрейт (kH/s)', en: 'Network hashrate (kH/s)' },
    'land.calc.per_hour':{ ru: '💰 В час',       en: '💰 Per hour' },
    'land.calc.per_day':{ ru: '📅 В день',        en: '📅 Per day' },
    'land.calc.per_week':{ ru: '📆 В неделю',     en: '📆 Per week' },
    'land.calc.per_month':{ ru: '🏆 В месяц',    en: '🏆 Per month' },
    'land.calc.share_note':{ ru: 'Твоя доля сети:', en: 'Your network share:' },
    'land.calc.of':     { ru: 'из',              en: 'of' },
    'land.calc.block_time':{ ru: 'Блок',         en: 'Block' },
    'land.calc.cores_unit':{ ru: 'ядра',         en: 'cores' },
    'land.calc.net_unit':  { ru: 'сеть',         en: 'net' },

    'land.dl.label':    { ru: '◆ Майнер',        en: '◆ Miner' },
    'land.dl.title':    { ru: 'CPU Майнер<br><span style="color:var(--accent)">для Windows</span>', en: 'CPU Miner<br><span style="color:var(--accent)">for Windows</span>' },
    'land.dl.sub':      { ru: 'Один .exe файл — без установки, без настройки. Пул уже зашит внутрь. Запустил, ввёл адрес — майнишь.', en: 'One .exe file — no installation, no setup. Pool is built in. Launch, enter address — mine.' },
    'land.dl.chip_mt':  { ru: 'Многопоточный',   en: 'Multi-threaded' },
    'land.dl.chip_pool':{ ru: 'Авто-пул',        en: 'Auto-pool' },
    'land.dl.btn_dl':   { ru: '⬇ Скачать майнер .exe', en: '⬇ Download miner .exe' },
    'land.dl.btn_tg':   { ru: '📱 Получить в Telegram', en: '📱 Get in Telegram' },

    'land.rm.label':    { ru: '◆ Дорожная карта', en: '◆ Roadmap' },
    'land.rm.title':    { ru: 'Что уже<br><span style="color:var(--gold)">сделано</span>', en: 'What has been<br><span style="color:var(--gold)">done</span>' },
    'land.rm.sub':      { ru: 'Проект активно развивается. Ранние майнеры получают монеты по минимальной сложности.', en: 'The project is actively growing. Early miners earn coins at minimum difficulty.' },

    'land.rm1.title':   { ru: 'Запуск основной сети', en: 'Mainnet launch' },
    'land.rm1.sub':     { ru: 'Блокчейн, ноды, Genesis-блок с эмиссией 1 млрд QTR', en: 'Blockchain, nodes, Genesis block with 1B QTR supply' },
    'land.rm1.badge':   { ru: 'Апрель 2026 ✓',  en: 'April 2026 ✓' },
    'land.rm2.title':   { ru: 'Майнинг-пул + CPU майнер', en: 'Mining pool + CPU miner' },
    'land.rm2.sub':     { ru: 'Windows .exe майнер, пул с автовыплатами каждые 5 минут', en: 'Windows .exe miner, pool with auto-payouts every 5 minutes' },
    'land.rm2.badge':   { ru: 'Апрель 2026 ✓',  en: 'April 2026 ✓' },
    'land.rm3.title':   { ru: 'Веб-кошелёк и обозреватель', en: 'Web wallet & explorer' },
    'land.rm3.sub':     { ru: 'Переводы, история, поиск блоков и транзакций', en: 'Transfers, history, block and transaction search' },
    'land.rm3.badge':   { ru: 'Апрель 2026 ✓',  en: 'April 2026 ✓' },
    'land.rm4.title':   { ru: 'Telegram бот',    en: 'Telegram bot' },
    'land.rm4.sub':     { ru: 'Кошелёк, переводы, статистика, уведомления о блоках, реферальная система', en: 'Wallet, transfers, stats, block notifications, referral system' },
    'land.rm4.badge':   { ru: 'Апрель 2026 ✓',  en: 'April 2026 ✓' },
    'land.rm5.title':   { ru: 'Рост сообщества', en: 'Community growth' },
    'land.rm5.sub':     { ru: 'Набор майнеров, Bitcointalk ANN, первые 1000 кошельков', en: 'Recruiting miners, Bitcointalk ANN, first 1000 wallets' },
    'land.rm5.badge':   { ru: 'В процессе',      en: 'In progress' },
    'land.rm6.title':   { ru: 'Linux майнер + Android', en: 'Linux miner + Android' },
    'land.rm6.sub':     { ru: 'Майнер для Linux/macOS, мобильное приложение', en: 'Miner for Linux/macOS, mobile app' },
    'land.rm7.title':   { ru: 'Листинг на бирже', en: 'Exchange listing' },
    'land.rm7.sub':     { ru: 'Торги QTR/USDT, ликвидность из genesis-резерва', en: 'QTR/USDT trading, liquidity from genesis reserve' },

    'land.faq.label':   { ru: '◆ Вопросы',       en: '◆ FAQ' },
    'land.faq.title':   { ru: 'Часто<br><span style="color:var(--gold)">спрашивают</span>', en: 'Frequently<br><span style="color:var(--gold)">Asked</span>' },
    'land.faq.q1':      { ru: 'Нужна ли видеокарта или ASIC для майнинга?', en: 'Do I need a GPU or ASIC for mining?' },
    'land.faq.a1':      { ru: 'Нет. QTR майнится на обычном процессоре (CPU). Майнер использует все ядра CPU автоматически. Подойдёт любой ноутбук или ПК с Windows 10/11.', en: 'No. QTR is mined on a regular CPU. The miner uses all CPU cores automatically. Any laptop or PC with Windows 10/11 will work.' },
    'land.faq.q2':      { ru: 'Как быстро приходят монеты после запуска?', en: 'How quickly do coins arrive after starting?' },
    'land.faq.a2':      { ru: 'Пул распределяет выплаты каждые 5 минут пропорционально шарам. Уже через несколько минут после запуска майнера ты увидишь первые QTR на балансе.', en: 'The pool distributes payouts every 5 minutes proportional to shares. Within minutes of starting the miner you will see your first QTR on the balance.' },
    'land.faq.q3':      { ru: 'Сколько QTR можно добыть?', en: 'How much QTR can I mine?' },
    'land.faq.a3':      { ru: 'За каждый найденный блок пул получает 16.7 QTR и делит между активными майнерами пропорционально хэшрейту. Чем больше у тебя ядер CPU — тем больше доля. Сложность автоматически подстраивается под общий хэшрейт сети, целевое время блока — около 10 минут.', en: 'For each block found, the pool receives 16.7 QTR and splits it among active miners proportionally by hashrate. The more CPU cores you have, the larger your share. Difficulty auto-adjusts to the network hashrate, targeting ~10 minute block times.' },
    'land.faq.q4':      { ru: 'Майнер безопасен? Это не вирус?', en: 'Is the miner safe? Is it a virus?' },
    'land.faq.a4':      { ru: 'Майнер — это open-source Node.js приложение, собранное в .exe через pkg. Оно использует только CPU и HTTP для связи с пулом. Антивирусы иногда ложно реагируют на self-contained .exe файлы — это нормально для подобного ПО.', en: 'The miner is an open-source Node.js application packaged into .exe via pkg. It only uses CPU and HTTP to communicate with the pool. Antivirus tools sometimes false-flag self-contained .exe files — this is normal for such software.' },
    'land.faq.q5':      { ru: 'Когда QTR будет на бирже?', en: 'When will QTR be on an exchange?' },
    'land.faq.a5':      { ru: 'Листинг запланирован на Q3–Q4 2026. Genesis-резерв (~380M QTR) будет использован для обеспечения ликвидности. Следи за новостями в Telegram канале.', en: 'Listing is planned for Q3–Q4 2026. The genesis reserve (~380M QTR) will be used to provide liquidity. Follow the news in the Telegram channel.' },
    'land.faq.q6':      { ru: 'Можно майнить с нескольких компьютеров на один адрес?', en: 'Can I mine from multiple computers to one address?' },
    'land.faq.a6':      { ru: 'Да. Просто запусти майнер на каждом ПК с одним и тем же адресом кошелька. Пул суммирует все шары от одного адреса и выплачивает пропорционально общему хэшрейту.', en: 'Yes. Just run the miner on each PC with the same wallet address. The pool sums all shares from one address and pays proportionally to total hashrate.' },

    'land.comm.label':  { ru: '◆ Сообщество',   en: '◆ Community' },
    'land.comm.title':  { ru: 'Присоединяйся к<br><span style="color:#229ed9">QatrolCoin</span>', en: 'Join<br><span style="color:#229ed9">QatrolCoin</span>' },
    'land.comm.sub':    { ru: 'Новости, обновления, статистика сети и общение с другими майнерами — всё в нашем Telegram канале.', en: 'News, updates, network stats and chat with other miners — all in our Telegram channel.' },
    'land.comm.btn_tg': { ru: '📢 Подписаться на канал', en: '📢 Join channel' },

    'land.footer.explorer':{ ru: 'Обозреватель', en: 'Explorer' },
    'land.footer.network': { ru: 'Сеть запущена', en: 'Network live' },

    // ── App page ──────────────────────────────────────────────────────────────
    'app.nav.dashboard':{ ru: 'Обзор',           en: 'Overview' },
    'app.nav.send':     { ru: 'Отправить',        en: 'Send' },
    'app.nav.receive':  { ru: 'Получить',         en: 'Receive' },
    'app.nav.mining':   { ru: 'Майнинг',          en: 'Mining' },
    'app.nav.explorer': { ru: 'Обозреватель',     en: 'Explorer' },
    'app.nav.mempool':  { ru: 'Очередь',          en: 'Mempool' },
    'app.logout':       { ru: 'Выйти',            en: 'Logout' },

    'app.dash.title':   { ru: 'Обзор сети',       en: 'Network Overview' },
    'app.dash.sub':     { ru: 'QTR Blockchain — фиксированная эмиссия 1,000,000,000', en: 'QTR Blockchain — fixed supply 1,000,000,000' },
    'app.dash.queued':  { ru: 'В очереди',        en: 'Queued' },
    'app.dash.fee':     { ru: 'Комиссия',         en: 'Fee' },
    'app.dash.valid':   { ru: 'Цепь валидна',     en: 'Chain valid' },
    'app.dash.uptime':  { ru: 'Аптайм',           en: 'Uptime' },
    'app.dash.recent_blocks':{ ru: 'Последние блоки', en: 'Recent Blocks' },

    'app.stats.sub':    { ru: 'Графики сети в реальном времени', en: 'Live network charts' },
    'app.stats.chart_blocktime':{ ru: 'Время блоков (сек)', en: 'Block time (sec)' },
    'app.stats.chart_txcount':  { ru: 'Транзакций в блоке', en: 'Txs per block' },
    'app.stats.emission':{ ru: 'Эмиссия QTR',     en: 'QTR Supply' },
    'app.stats.total':  { ru: 'Всего:',           en: 'Total:' },
    'app.stats.fixed':  { ru: 'фиксировано навсегда', en: 'fixed forever' },
    'app.stats.genesis_wallet':{ ru: 'На genesis-кошельке:', en: 'Genesis wallet:' },

    'app.wallet.sub':   { ru: 'Баланс и история', en: 'Balance & history' },
    'app.wallet.pending':{ ru: 'В обработке:',   en: 'Pending:' },
    'app.wallet.mnemonic_btn':{ ru: '🔑 Мнемоник', en: '🔑 Mnemonic' },
    'app.wallet.history':{ ru: 'История транзакций', en: 'Transaction history' },

    'app.send.title':   { ru: 'Отправить QTR',   en: 'Send QTR' },
    'app.send.sub':     { ru: 'Транзакция подписывается ECDSA ключом', en: 'Transaction is signed with ECDSA key' },
    'app.send.from':    { ru: 'От',              en: 'From' },
    'app.send.to':      { ru: 'Получатель',      en: 'Recipient' },
    'app.send.to_ph':   { ru: 'K...',            en: 'K...' },
    'app.send.amount':  { ru: 'Сумма (QTR)',     en: 'Amount (QTR)' },
    'app.send.fee_label':{ ru: 'Комиссия (авто 0.1%)', en: 'Fee (auto 0.1%)' },
    'app.send.memo':    { ru: 'Заметка',         en: 'Memo' },
    'app.send.memo_ph': { ru: 'За что платёж...', en: 'Payment note...' },
    'app.send.password':{ ru: 'Пароль (для подписи транзакции)', en: 'Password (to sign transaction)' },
    'app.send.pass_ph': { ru: 'Ваш пароль от кошелька', en: 'Your wallet password' },
    'app.send.total':   { ru: 'Итого:',          en: 'Total:' },
    'app.send.fee_note':{ ru: 'Комиссия идёт майнеру блока', en: 'Fee goes to the block miner' },
    'app.send.btn':     { ru: 'Подписать и отправить ↗', en: 'Sign and send ↗' },

    'app.recv.title':   { ru: 'Получить QTR',    en: 'Receive QTR' },
    'app.recv.sub':     { ru: 'Покажи QR или скопируй адрес', en: 'Show QR or copy address' },
    'app.recv.your_addr':{ ru: 'Ваш адрес',      en: 'Your address' },
    'app.recv.hint':    { ru: 'QR содержит адрес кошелька (ECDSA secp256k1)', en: 'QR contains wallet address (ECDSA secp256k1)' },

    'app.exp.sub':      { ru: 'Все блоки и транзакции', en: 'All blocks and transactions' },
    'app.exp.search_ph':{ ru: 'Хэш блока · ID транзакции · адрес...', en: 'Block hash · Tx ID · address...' },
    'app.exp.search_btn':{ ru: 'Найти',          en: 'Search' },

    'app.mempool.title':{ ru: 'Очередь транзакций', en: 'Transaction Queue' },
    'app.mempool.sub':  { ru: 'Ожидают подтверждения майнером', en: 'Awaiting miner confirmation' },
    'app.mempool.queued':{ ru: 'В очереди:',     en: 'Queued:' },
    'app.mempool.fees': { ru: 'Комиссий:',       en: 'Fees:' },
    'app.mempool.empty':{ ru: 'Очередь пуста',   en: 'Queue is empty' },

    'app.mining.sub':   { ru: 'Статистика пула, топ майнеров и загрузка майнера', en: 'Pool stats, top miners and miner download' },
    'app.mining.total_shares':{ ru: 'Всего шар', en: 'Total shares' },
    'app.mining.cur_block':   { ru: 'Текущий блок', en: 'Current block' },
    'app.mining.pool_fee':    { ru: 'Комиссия пула', en: 'Pool fee' },
    'app.mining.my_stats':    { ru: 'Мои результаты', en: 'My stats' },
    'app.mining.start_hint':  { ru: 'Запустите майнер чтобы увидеть статистику', en: 'Start the miner to see stats' },
    'app.mining.miner_title': { ru: '⛏ CPU Майнер для Windows', en: '⛏ CPU Miner for Windows' },
    'app.mining.miner_desc':  { ru: 'Многопоточный · SHA-256 PoW · Авто-подключение к пулу · 16.7 QTR за блок', en: 'Multi-threaded · SHA-256 PoW · Auto-connect to pool · 16.7 QTR per block' },
    'app.mining.dl_btn':      { ru: '↓ Скачать .exe', en: '↓ Download .exe' },
    'app.mining.step1':       { ru: '1. Скачай майнер выше и запусти .exe', en: '1. Download the miner above and run .exe' },
    'app.mining.step2':       { ru: '2. Введи адрес кошелька:', en: '2. Enter wallet address:' },
    'app.mining.step3':       { ru: '3. Пул подключится автоматически — майнинг начнётся', en: '3. Pool connects automatically — mining starts' },
    'app.mining.step4':       { ru: '4. Выплаты каждые 5 минут пропорционально шарам', en: '4. Payouts every 5 min proportional to shares' },
    'app.mining.top_miners':  { ru: 'Топ майнеров', en: 'Top miners' },

    'app.network.title':{ ru: 'Сеть',            en: 'Network' },
    'app.network.sub':  { ru: 'P2P пиры и статус синхронизации', en: 'P2P peers and sync status' },
    'app.network.peers':{ ru: 'Подключённые пиры', en: 'Connected peers' },
    'app.network.no_peers':{ ru: 'Пиров нет',    en: 'No peers' },
    'app.network.node_info':{ ru: 'Информация о ноде', en: 'Node info' },
  };

  // Current language
  let lang = localStorage.getItem(STORAGE_KEY) || 'ru';

  // Translate a key
  function t(key) {
    const entry = translations[key];
    if (!entry) return key;
    return entry[lang] || entry['ru'] || key;
  }

  // Apply data-i18n attributes to all elements on the page
  function apply() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = t(el.dataset.i18nHtml);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.dataset.i18nTitle);
    });
    // Update html lang attribute
    document.documentElement.lang = lang;
    // Update the floating button label
    const fab = document.getElementById('lang-fab');
    if (fab) {
      fab.textContent = lang === 'ru' ? '🌐 EN' : '🌐 RU';
      fab.title = lang === 'ru' ? 'Switch to English' : 'Переключить на русский';
    }
    const navBtn = document.getElementById('lang-toggle');
    if (navBtn) {
      navBtn.textContent = lang === 'ru' ? 'EN' : 'RU';
      navBtn.title = lang === 'ru' ? 'Switch to English' : 'Переключить на русский';
    }
  }

  function switchLang() {
    lang = lang === 'ru' ? 'en' : 'ru';
    localStorage.setItem(STORAGE_KEY, lang);
    apply();
    document.dispatchEvent(new CustomEvent('langchange', { detail: { lang } }));
  }

  // Nav toggle — no longer injected to avoid breaking flex layouts
  function injectNavToggle() { /* FAB handles language switching */ }

  // Inject prominent fixed FAB (Floating Action Button) — always visible, all pages
  function injectFAB() {
    if (document.getElementById('lang-fab')) return;

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #lang-fab {
        position: fixed !important;
        bottom: 24px !important;
        right: 24px !important;
        z-index: 2147483647 !important;
        background: linear-gradient(135deg, #8b6914, #d4af37) !important;
        color: #000 !important;
        border: 2px solid rgba(212,175,55,.6) !important;
        border-radius: 50px !important;
        padding: 12px 22px !important;
        font-family: "Space Mono", monospace !important;
        font-size: 14px !important;
        font-weight: 700 !important;
        letter-spacing: 1px !important;
        cursor: pointer !important;
        box-shadow: 0 4px 24px rgba(212,175,55,.55), 0 2px 8px rgba(0,0,0,.5) !important;
        transition: all .2s !important;
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        white-space: nowrap !important;
        user-select: none !important;
        pointer-events: all !important;
        text-decoration: none !important;
        outline: none !important;
      }
      #lang-fab:hover {
        background: linear-gradient(135deg, #d4af37, #f5e27a) !important;
        transform: translateY(-2px) !important;
        box-shadow: 0 6px 32px rgba(212,175,55,.7), 0 2px 10px rgba(0,0,0,.5) !important;
      }
      #lang-fab:active {
        transform: translateY(0) !important;
      }
      @media (max-width: 600px) {
        #lang-fab {
          bottom: 16px !important;
          right: 16px !important;
          padding: 10px 16px !important;
          font-size: 13px !important;
        }
      }
    `;
    document.head.appendChild(style);

    const fab = document.createElement('button');
    fab.id = 'lang-fab';
    fab.textContent = lang === 'ru' ? '🌐 EN' : '🌐 RU';
    fab.title = lang === 'ru' ? 'Switch to English' : 'Переключить на русский';
    fab.onclick = switchLang;
    document.body.appendChild(fab);
  }

  // Public API
  window.I18n = { t, apply, lang: () => lang };
  window.T = t;

  // Auto-run when DOM is ready
  function init() {
    injectNavToggle();
    injectFAB();
    apply();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
