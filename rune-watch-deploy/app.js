const {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect
} = React;
// ============================================================================
// SPENDEN-ADRESSEN. Nutzer können frei wählen, ob sie nativ auf THORChain oder auf
// Ethereum (bzw. jede EVM-Chain, die dieselbe Adresse bedient) senden möchten.
// Beide Einträge werden nur angezeigt, wenn sie ein gültiges Format haben -- steht dort
// noch ein Platzhalter oder Unsinn, blendet die Seite den jeweiligen Eintrag aus, damit
// niemand versehentlich an eine ungültige Adresse sendet. Sind BEIDE ungültig, verschwindet
// der Spenden-Bereich komplett.
// ============================================================================
const DONATION_ADDRESSES = [
  { chain: 'THORChain', assetsHintKey: 'donateAssetsThorchain', address: 'thor1nzyddftjwdfnnwxrs849stf2yw6c9xzda5jeuy' },
  { chain: 'Ethereum', assetsHintKey: 'donateAssetsEthereum', address: '0x4a342E59Dbbd29b4D254a0975A980467bf4B1Bc1' },
].filter((d) => /^thor1[0-9a-z]{20,60}$/.test(d.address) || /^0x[0-9a-fA-F]{40}$/.test(d.address));
const DONATION_ENABLED = DONATION_ADDRESSES.length > 0;

const RANGES = [{
  label: '7T',
  labelEn: '7D',
  days: 7
}, {
  label: '30T',
  labelEn: '30D',
  days: 30
}, {
  label: '90T',
  labelEn: '90D',
  days: 90
}, {
  label: '1J',
  labelEn: '1Y',
  days: 365
}];
// Zeitraum-Optionen für den einfachen RUNE-Preis-Übersichts-Chart (täglich/wöchentlich/
// monatlich). Nutzt bewusst dieselbe rangeLabel()-Funktion wie RANGES oben, damit die
// Beschriftung exakt im gleichen Stil erscheint wie beim Portfolio-Wert-Chart.
const RUNE_PRICE_CHART_RANGES = [1, 7, 30, 90, 365, 1095];

// Auswählbare Kaufquellen im Kaufpreis-Tracker. "csv" wird nicht im Dropdown angeboten,
// sondern automatisch für per CSV-Import erfasste Einträge gesetzt.
const PURCHASE_SOURCES = [{
  value: 'binance',
  labelKey: 'purchaseSourceBinance'
}, {
  value: 'kraken',
  labelKey: 'purchaseSourceKraken'
}, {
  value: 'coinbase',
  labelKey: 'purchaseSourceCoinbase'
}, {
  value: 'kucoin',
  labelKey: 'purchaseSourceKucoin'
}, {
  value: 'okx',
  labelKey: 'purchaseSourceOkx'
}, {
  value: 'bybit',
  labelKey: 'purchaseSourceBybit'
}, {
  value: 'dex',
  labelKey: 'purchaseSourceDex'
}, {
  value: 'other',
  labelKey: 'purchaseSourceOther'
}];
const purchaseSourceLabel = (source, lang) => {
  if (source === 'csv') return t('purchaseSourceCsv', lang);
  const found = PURCHASE_SOURCES.find(s => s.value === source);
  return found ? t(found.labelKey, lang) : t('purchaseSourceOther', lang);
};
const fmtUSD = (n, lang, currency) => n == null ? '—' : n.toLocaleString(localeFor(lang), {
  style: 'currency',
  currency: (currency || 'usd').toUpperCase(),
  maximumFractionDigits: 2
});

// Gerundet auf ganze Zahl, ohne Nachkommastellen (z.B. für große Volumen-Zahlen).
const fmtUSDRounded = (n, lang, currency) => n == null ? '—' : Math.round(n).toLocaleString(localeFor(lang), {
  style: 'currency',
  currency: (currency || 'usd').toUpperCase(),
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

// Extrem gerundete, kompakte Darstellung großer Beträge, z.B. "22,2 Mio. $" -> hier als "22,2M".
// Nutzt K/M/B-Suffixe mit einer Nachkommastelle statt der vollen Zahl.
const fmtUSDCompact = (n, lang, currency) => {
  if (n == null) return '—';
  const symbol = getCurrencySymbol((currency || 'usd').toLowerCase());
  const abs = Math.abs(n);
  const locale = localeFor(lang);
  let value, suffix;
  if (abs >= 1e9) {
    value = n / 1e9;
    suffix = 'B';
  } else if (abs >= 1e6) {
    value = n / 1e6;
    suffix = 'M';
  } else if (abs >= 1e3) {
    value = n / 1e3;
    suffix = 'K';
  } else {
    value = n;
    suffix = '';
  }
  const formatted = value.toLocaleString(locale, {
    minimumFractionDigits: suffix ? 1 : 0,
    maximumFractionDigits: suffix ? 1 : 0
  });
  return `${symbol}${formatted}${suffix}`;
};

// Für den RUNE-Preis selbst (z.B. "$1.234 / RUNE") — 3 statt 2 Nachkommastellen,
// da RUNE oft im niedrigen Dollarbereich liegt und mehr Präzision hier hilfreich ist.
const fmtUSDPrecise = (n, lang, currency) => n == null ? '—' : n.toLocaleString(localeFor(lang), {
  style: 'currency',
  currency: (currency || 'usd').toUpperCase(),
  minimumFractionDigits: 3,
  maximumFractionDigits: 3
});

// Für RUNE/BTC bzw. RUNE/ETH: keine Fiat-Währung, sondern ein Kurspaar-Verhältnis, meist
// ein sehr kleiner Dezimalwert (z.B. 0,0000045 BTC). Nachkommastellen passen sich der
// Größenordnung an, damit weder unnötig viele Nullen noch zu wenig Präzision angezeigt werden.
const fmtRuneQuoteValue = (n, lang) => {
  if (n == null) return '—';
  const decimals = n >= 1 ? 2 : n >= 0.01 ? 4 : n >= 0.0001 ? 6 : 8;
  return n.toLocaleString(localeFor(lang), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

// RUNE/BTC in Satoshis statt in langen BTC-Nachkommastellen (1 BTC = 100.000.000 Satoshi) --
// deutlich kürzer und in der Krypto-Welt die übliche Einheit für so kleine Kurspaar-Werte.
const fmtSats = (btcValue, lang) => {
  if (btcValue == null) return '—';
  const sats = btcValue * 1e8;
  const decimals = sats >= 10 ? 0 : sats >= 1 ? 1 : 2;
  return sats.toLocaleString(localeFor(lang), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

// RUNE/ETH in Gwei statt in langen ETH-Nachkommastellen (1 ETH = 1.000.000.000 Gwei) --
// dieselbe Idee wie Satoshi bei BTC, nur für ETH die dort übliche kleine Einheit.
const fmtGwei = (ethValue, lang) => {
  if (ethValue == null) return '—';
  const gwei = ethValue * 1e9;
  const decimals = gwei >= 10 ? 0 : gwei >= 1 ? 1 : 2;
  return gwei.toLocaleString(localeFor(lang), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

// Kompakte K/M-Kurzform für die Chart-eigenen Beschriftungen (Y-Achse, horizontale Linien,
// Live-Preis-Label, Crosshair) -- dort ist nur sehr wenig Platz (schmaler Rand links), eine
// volle Zahl mit Tausendertrennzeichen plus Einheit würde dort abgeschnitten werden.
const fmtCompactUnitValue = n => {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  if (abs >= 10) return n.toFixed(0);
  return n.toFixed(abs >= 1 ? 1 : 2);
};
const fmtSatsCompact = btcValue => btcValue == null ? '—' : fmtCompactUnitValue(btcValue * 1e8);
const fmtGweiCompact = ethValue => ethValue == null ? '—' : fmtCompactUnitValue(ethValue * 1e9);

// ---------------------------------------------------------------------------
// Mehrsprachigkeit: 10 Sprachen statt nur DE/EN. TR ist ein Übersetzungs-
// Wörterbuch (Schlüssel -> Text je Sprache); t(key, lang) holt den Text für die
// aktuelle Sprache und fällt auf Englisch zurück, falls ein Schlüssel für eine
// Sprache fehlen sollte. localeFor(lang) liefert den passenden BCP-47-Locale-
// Code für Intl-Zahlen-/Datumsformatierung.
const LANGUAGE_OPTIONS = [{
  code: 'de',
  label: 'Deutsch',
  locale: 'de-DE'
}, {
  code: 'en',
  label: 'English',
  locale: 'en-US'
}, {
  code: 'es',
  label: 'Español',
  locale: 'es-ES'
}, {
  code: 'fr',
  label: 'Français',
  locale: 'fr-FR'
}, {
  code: 'it',
  label: 'Italiano',
  locale: 'it-IT'
}, {
  code: 'pt',
  label: 'Português',
  locale: 'pt-PT'
}, {
  code: 'ja',
  label: '日本語',
  locale: 'ja-JP'
}, {
  code: 'zh',
  label: '中文',
  locale: 'zh-CN'
}, {
  code: 'ru',
  label: 'Русский',
  locale: 'ru-RU'
}, {
  code: 'ko',
  label: '한국어',
  locale: 'ko-KR'
}];
const localeFor = lang => (LANGUAGE_OPTIONS.find(l => l.code === lang) || LANGUAGE_OPTIONS[1]).locale;
const RANGE_UNIT_LABELS = {
  de: {
    d: 'T',
    y: 'J'
  },
  en: {
    d: 'D',
    y: 'Y'
  },
  es: {
    d: 'D',
    y: 'A'
  },
  fr: {
    d: 'J',
    y: 'A'
  },
  it: {
    d: 'G',
    y: 'A'
  },
  pt: {
    d: 'D',
    y: 'A'
  },
  ja: {
    d: '日',
    y: '年'
  },
  zh: {
    d: '天',
    y: '年'
  },
  ru: {
    d: 'Д',
    y: 'Г'
  },
  ko: {
    d: '일',
    y: '년'
  }
};
const rangeLabel = (days, lang) => {
  const u = RANGE_UNIT_LABELS[lang] || RANGE_UNIT_LABELS.en;
  if (days >= 365) {
    const years = Math.round(days / 365);
    return `${years}${u.y}`;
  }
  return `${days}${u.d}`;
};
const TR = {
  notEnoughData: {
    en: 'Not enough data for this period.',
    de: 'Nicht genug Daten für diesen Zeitraum.',
    es: 'No hay suficientes datos para este período.',
    fr: 'Pas assez de données pour cette période.',
    it: 'Dati insufficienti per questo periodo.',
    pt: 'Dados insuficientes para este período.',
    ja: 'この期間のデータが不足しています。',
    zh: '此时间段的数据不足。',
    ru: 'Недостаточно данных за этот период.',
    ko: '이 기간에 대한 데이터가 부족합니다.'
  },
  toolSelect: {
    en: 'Select',
    de: 'Auswählen',
    es: 'Seleccionar',
    fr: 'Sélectionner',
    it: 'Seleziona',
    pt: 'Selecionar',
    ja: '選択',
    zh: '选择',
    ru: 'Выбрать',
    ko: '선택'
  },
  toolHLine: {
    en: 'Horizontal line',
    de: 'Horizontale Linie',
    es: 'Línea horizontal',
    fr: 'Ligne horizontale',
    it: 'Linea orizzontale',
    pt: 'Linha horizontal',
    ja: '水平線',
    zh: '水平线',
    ru: 'Горизонтальная линия',
    ko: '수평선'
  },
  toolTrend: {
    en: 'Trend line (press & drag)',
    de: 'Trendlinie (drücken & ziehen)',
    es: 'Línea de tendencia (mantén y arrastra)',
    fr: 'Ligne de tendance (appuyer puis glisser)',
    it: 'Linea di tendenza (tieni premuto e trascina)',
    pt: 'Linha de tendência (pressione e arraste)',
    ja: 'トレンドライン（長押しでドラッグ）',
    zh: '趋势线（按住并拖动）',
    ru: 'Линия тренда (нажмите и потяните)',
    ko: '추세선 (누르고 드래그)'
  },
  toolLineMenu: {
    en: 'Draw line',
    de: 'Linie zeichnen',
    es: 'Dibujar línea',
    fr: 'Dessiner une ligne',
    it: 'Disegna linea',
    pt: 'Desenhar linha',
    ja: '線を描く',
    zh: '绘制线条',
    ru: 'Нарисовать линию',
    ko: '선 그리기'
  },
  resetZoom: {
    en: 'Reset zoom',
    de: 'Zoom zurücksetzen',
    es: 'Restablecer zoom',
    fr: 'Réinitialiser le zoom',
    it: 'Reimposta zoom',
    pt: 'Repor zoom',
    ja: 'ズームをリセット',
    zh: '重置缩放',
    ru: 'Сбросить масштаб',
    ko: '확대/축소 초기화'
  },
  zoomIn: {
    en: 'Zoom in',
    de: 'Reinzoomen',
    es: 'Acercar',
    fr: 'Zoomer',
    it: 'Ingrandisci',
    pt: 'Ampliar',
    ja: 'ズームイン',
    zh: '放大',
    ru: 'Увеличить',
    ko: '확대'
  },
  zoomOut: {
    en: 'Zoom out',
    de: 'Rauszoomen',
    es: 'Alejar',
    fr: 'Dézoomer',
    it: 'Rimpicciolisci',
    pt: 'Reduzir',
    ja: 'ズームアウト',
    zh: '缩小',
    ru: 'Уменьшить',
    ko: '축소'
  },
  logScale: {
    en: 'Log',
    de: 'Log',
    es: 'Log',
    fr: 'Log',
    it: 'Log',
    pt: 'Log',
    ja: 'Log',
    zh: 'Log',
    ru: 'Лог',
    ko: 'Log'
  },
  scrollToZoom: {
    en: 'Scroll to zoom, drag to pan',
    de: 'Scrollen zum Zoomen, Ziehen zum Verschieben',
    es: 'Desplázate para hacer zoom, arrastra para desplazar',
    fr: 'Défilez pour zoomer, glissez pour déplacer',
    it: 'Scorri per zoomare, trascina per spostare',
    pt: 'Deslize para ampliar, arraste para mover',
    ja: 'スクロールでズーム、ドラッグで移動',
    zh: '滚动缩放，拖动平移',
    ru: 'Прокрутка — масштаб, перетаскивание — сдвиг',
    ko: '스크롤로 확대/축소, 드래그로 이동'
  },
  deleteSelectedDrawing: {
    en: 'Delete selected drawing',
    de: 'Ausgewählte Zeichnung löschen',
    es: 'Eliminar dibujo seleccionado',
    fr: 'Supprimer le dessin sélectionné',
    it: 'Elimina disegno selezionato',
    pt: 'Excluir desenho selecionado',
    ja: '選択した描画を削除',
    zh: '删除所选图形',
    ru: 'Удалить выбранный рисунок',
    ko: '선택한 그림 삭제'
  },
  tapDrawingFirst: {
    en: 'Tap a drawing first, then delete it',
    de: 'Erst eine Zeichnung antippen, dann löschen',
    es: 'Toca un dibujo primero, luego elimínalo',
    fr: 'Touchez un dessin, puis supprimez-le',
    it: 'Tocca un disegno, poi eliminalo',
    pt: 'Toque num desenho e depois exclua-o',
    ja: 'まず描画をタップしてから削除してください',
    zh: '先点选图形，再删除',
    ru: 'Сначала выберите рисунок, затем удалите',
    ko: '먼저 그림을 탭한 후 삭제하세요'
  },
  tapChartPlaceLine: {
    en: 'Tap the chart to place the line',
    de: 'Auf den Chart tippen, um die Linie zu setzen',
    es: 'Toca el gráfico para colocar la línea',
    fr: 'Touchez le graphique pour placer la ligne',
    it: 'Tocca il grafico per posizionare la linea',
    pt: 'Toque no gráfico para colocar a linha',
    ja: 'チャートをタップして線を配置',
    zh: '点击图表放置线条',
    ru: 'Нажмите на график, чтобы разместить линию',
    ko: '차트를 탭하여 선을 배치하세요'
  },
  tapStartPoint: {
    en: 'Press & drag to draw',
    de: 'Drücken & ziehen zum Zeichnen',
    es: 'Mantén y arrastra para dibujar',
    fr: 'Appuyez et glissez pour dessiner',
    it: 'Tieni premuto e trascina per disegnare',
    pt: 'Pressione e arraste para desenhar',
    ja: '長押しでドラッグして描画',
    zh: '按住并拖动进行绘制',
    ru: 'Нажмите и потяните, чтобы нарисовать',
    ko: '누르고 드래그하여 그리기'
  },
  deleteWord: {
    en: 'Delete',
    de: 'Löschen',
    es: 'Eliminar',
    fr: 'Supprimer',
    it: 'Elimina',
    pt: 'Excluir',
    ja: '削除',
    zh: '删除',
    ru: 'Удалить',
    ko: '삭제'
  },
  undoDrawing: {
    en: 'Undo last line',
    de: 'Letzte Linie rückgängig machen',
    es: 'Deshacer última línea',
    fr: 'Annuler la dernière ligne',
    it: 'Annulla ultima linea',
    pt: 'Desfazer última linha',
    ja: '最後の線を元に戻す',
    zh: '撤销最后一条线',
    ru: 'Отменить последнюю линию',
    ko: '마지막 선 실행 취소'
  },
  tapTrashToDelete: {
    en: 'Tap the trash icon above to delete it',
    de: 'Zum Löschen oben auf das Papierkorb-Symbol tippen',
    es: 'Toca el icono de papelera arriba para eliminarlo',
    fr: 'Touchez l\'icône de corbeille ci-dessus pour le supprimer',
    it: 'Tocca l\'icona del cestino sopra per eliminarlo',
    pt: 'Toque no ícone da lixeira acima para excluir',
    ja: '上のゴミ箱アイコンをタップして削除',
    zh: '点击上方垃圾桶图标删除',
    ru: 'Нажмите на значок корзины выше, чтобы удалить',
    ko: '위의 휴지통 아이콘을 탭하여 삭제하세요'
  },
  last7d: {
    en: 'Last 7d',
    de: 'Letzte 7 Tage',
    es: 'Últimos 7 días',
    fr: '7 derniers jours',
    it: 'Ultimi 7 giorni',
    pt: 'Últimos 7 dias',
    ja: '過去7日間',
    zh: '最近7天',
    ru: 'Последние 7 дней',
    ko: '최근 7일'
  },
  last30d: {
    en: 'Last 30d',
    de: 'Letzte 30 Tage',
    es: 'Últimos 30 días',
    fr: '30 derniers jours',
    it: 'Ultimi 30 giorni',
    pt: 'Últimos 30 dias',
    ja: '過去30日間',
    zh: '最近30天',
    ru: 'Последние 30 дней',
    ko: '최근 30일'
  },
  tapOpenFullChart: {
    en: 'Tap to open the full chart (drawing available)',
    de: 'Tippen für den vollen Chart (Zeichnen möglich)',
    es: 'Toca para abrir el gráfico completo (con dibujo)',
    fr: 'Touchez pour ouvrir le graphique complet (dessin possible)',
    it: 'Tocca per aprire il grafico completo (disegno disponibile)',
    pt: 'Toque para abrir o gráfico completo (com desenho)',
    ja: 'フルチャートを開く（描画可能）',
    zh: '点击打开完整图表（可绘图）',
    ru: 'Нажмите, чтобы открыть полный график (доступно рисование)',
    ko: '전체 차트 열기 (그리기 가능)'
  },
  loading: {
    en: 'Loading…',
    de: 'Lädt…',
    es: 'Cargando…',
    fr: 'Chargement…',
    it: 'Caricamento…',
    pt: 'A carregar…',
    ja: '読み込み中…',
    zh: '加载中…',
    ru: 'Загрузка…',
    ko: '로딩 중…'
  },
  tapToDraw: {
    en: 'Tap to draw',
    de: 'Tippen zum Zeichnen',
    es: 'Toca para dibujar',
    fr: 'Touchez pour dessiner',
    it: 'Tocca per disegnare',
    pt: 'Toque para desenhar',
    ja: 'タップして描画',
    zh: '点击绘图',
    ru: 'Нажмите, чтобы рисовать',
    ko: '탭하여 그리기'
  },
  priceWord: {
    en: 'Price',
    de: 'Preis',
    es: 'Precio',
    fr: 'Prix',
    it: 'Prezzo',
    pt: 'Preço',
    ja: '価格',
    zh: '价格',
    ru: 'Цена',
    ko: '가격'
  },
  liveWord: {
    en: 'Live',
    de: 'Live',
    es: 'En vivo',
    fr: 'En direct',
    it: 'Live',
    pt: 'Ao vivo',
    ja: 'ライブ',
    zh: '实时',
    ru: 'Live',
    ko: '실시간'
  },
  closeWord: {
    en: 'Close',
    de: 'Schließen',
    es: 'Cerrar',
    fr: 'Fermer',
    it: 'Chiudi',
    pt: 'Fechar',
    ja: '閉じる',
    zh: '关闭',
    ru: 'Закрыть',
    ko: '닫기'
  },
  drawingsSaved: {
    en: 'Drawings are saved on this device and stay attached to this chart.',
    de: 'Zeichnungen werden auf diesem Gerät gespeichert und bleiben an diesem Chart erhalten.',
    es: 'Los dibujos se guardan en este dispositivo y permanecen en este gráfico.',
    fr: 'Les dessins sont enregistrés sur cet appareil et restent liés à ce graphique.',
    it: 'I disegni vengono salvati su questo dispositivo e restano legati a questo grafico.',
    pt: 'Os desenhos são guardados neste dispositivo e ficam associados a este gráfico.',
    ja: '描画はこの端末に保存され、このチャートに残ります。',
    zh: '绘图内容保存在本设备上，并保留在此图表中。',
    ru: 'Рисунки сохраняются на этом устройстве и остаются на этом графике.',
    ko: '그림은 이 기기에 저장되며 이 차트에 계속 남습니다.'
  },
  invalidAddress: {
    en: 'This doesn\'t look like a THORChain address. It should start with "thor1".',
    de: 'Das sieht nicht nach einer THORChain-Adresse aus. Sie sollte mit "thor1" beginnen.',
    es: 'Esto no parece una dirección de THORChain. Debería empezar con "thor1".',
    fr: "Cela ne ressemble pas à une adresse THORChain. Elle doit commencer par « thor1 ».",
    it: 'Non sembra un indirizzo THORChain. Dovrebbe iniziare con "thor1".',
    pt: 'Isto não parece um endereço THORChain. Deve começar com "thor1".',
    ja: 'THORChainアドレスのようではありません。"thor1"で始まる必要があります。',
    zh: '这看起来不像 THORChain 地址，应以 "thor1" 开头。',
    ru: 'Это не похоже на адрес THORChain. Он должен начинаться с "thor1".',
    ko: 'THORChain 주소처럼 보이지 않습니다. "thor1"로 시작해야 합니다.'
  },
  addressNotFound: {
    en: 'Address not found. Check that this is a valid THORChain address (thor1...).',
    de: 'Adresse nicht gefunden. Prüfe, ob es eine gültige THORChain-Adresse (thor1...) ist.',
    es: 'Dirección no encontrada. Verifica que sea una dirección THORChain válida (thor1...).',
    fr: "Adresse introuvable. Vérifiez qu'il s'agit d'une adresse THORChain valide (thor1...).",
    it: 'Indirizzo non trovato. Verifica che sia un indirizzo THORChain valido (thor1...).',
    pt: 'Endereço não encontrado. Verifique se é um endereço THORChain válido (thor1...).',
    ja: 'アドレスが見つかりません。有効なTHORChainアドレス（thor1...）か確認してください。',
    zh: '未找到该地址，请确认这是有效的 THORChain 地址（thor1...）。',
    ru: 'Адрес не найден. Проверьте, что это действительный адрес THORChain (thor1...).',
    ko: '주소를 찾을 수 없습니다. 유효한 THORChain 주소(thor1...)인지 확인하세요.'
  },
  corsError: {
    en: 'Could not load the THORChain balance right now. Retrying automatically…',
    de: 'Die THORChain-Balance konnte gerade nicht geladen werden. Wird automatisch erneut versucht…',
    es: 'No se pudo cargar el saldo de THORChain en este momento. Reintentando automáticamente…',
    fr: "Impossible de charger le solde THORChain pour le moment. Nouvelle tentative automatique…",
    it: "Impossibile caricare il saldo THORChain al momento. Nuovo tentativo automatico…",
    pt: 'Não foi possível carregar o saldo THORChain agora. Tentando novamente automaticamente…',
    ja: '現在THORChainの残高を読み込めません。自動的に再試行しています…',
    zh: '暂时无法加载 THORChain 余额，正在自动重试…',
    ru: 'Не удалось загрузить баланс THORChain. Автоматическая повторная попытка…',
    ko: '지금은 THORChain 잔액을 불러올 수 없습니다. 자동으로 다시 시도하는 중…'
  },
  genericError: {
    en: 'Something went wrong. Please try again.',
    de: 'Etwas ist schiefgelaufen. Bitte erneut versuchen.',
    es: 'Algo salió mal. Inténtalo de nuevo.',
    fr: "Une erreur s'est produite. Veuillez réessayer.",
    it: 'Qualcosa è andato storto. Riprova.',
    pt: 'Algo correu mal. Tente novamente.',
    ja: '問題が発生しました。もう一度お試しください。',
    zh: '出现问题，请重试。',
    ru: 'Что-то пошло не так. Попробуйте снова.',
    ko: '문제가 발생했습니다. 다시 시도해 주세요.'
  },
  autoRetrying: {
    en: 'Retrying automatically…',
    de: 'Wird automatisch erneut versucht…',
    es: 'Reintentando automáticamente…',
    fr: 'Nouvelle tentative automatique…',
    it: 'Nuovo tentativo automatico…',
    pt: 'Tentando novamente automaticamente…',
    ja: '自動的に再試行しています…',
    zh: '正在自动重试…',
    ru: 'Автоматическая повторная попытка…',
    ko: '자동으로 다시 시도하는 중…'
  },
  tapChooseCoin: {
    en: 'Tap to choose a different coin',
    de: 'Tippen, um einen anderen Coin zu wählen',
    es: 'Toca para elegir otra moneda',
    fr: 'Touchez pour choisir une autre monnaie',
    it: 'Tocca per scegliere un\'altra moneta',
    pt: 'Toque para escolher outra moeda',
    ja: 'タップして別のコインを選択',
    zh: '点击选择其他币种',
    ru: 'Нажмите, чтобы выбрать другую монету',
    ko: '탭하여 다른 코인 선택'
  },
  viewPriceChart: {
    en: 'Tap to view price chart',
    de: 'Tippen, um den Preischart zu öffnen',
    es: 'Toca para ver el gráfico de precio',
    fr: 'Touchez pour voir le graphique de prix',
    it: 'Tocca per vedere il grafico del prezzo',
    pt: 'Toque para ver o gráfico de preço',
    ja: 'タップして価格チャートを表示',
    zh: '点击查看价格图表',
    ru: 'Нажмите, чтобы открыть график цены',
    ko: '탭하여 가격 차트 보기'
  },
  viewCompareChart: {
    en: 'Tap to compare with RUNE',
    de: 'Tippen, um mit RUNE zu vergleichen',
    es: 'Toca para comparar con RUNE',
    fr: 'Touchez pour comparer avec RUNE',
    it: 'Tocca per confrontare con RUNE',
    pt: 'Toque para comparar com RUNE',
    ja: 'タップしてRUNEと比較',
    zh: '点击与 RUNE 比较',
    ru: 'Нажмите, чтобы сравнить с RUNE',
    ko: '탭하여 RUNE과 비교'
  },
  compareVsRune: {
    en: 'vs RUNE',
    de: 'vs. RUNE',
    es: 'vs RUNE',
    fr: 'vs RUNE',
    it: 'vs RUNE',
    pt: 'vs RUNE',
    ja: 'vs RUNE',
    zh: 'vs RUNE',
    ru: 'vs RUNE',
    ko: 'vs RUNE'
  },
  marketcapPctVsRune: {
    en: 'Marketcap % of RUNE',
    de: 'Marketcap-Anteil an RUNE',
    es: '% de Marketcap vs RUNE',
    fr: '% de capitalisation vs RUNE',
    it: '% di Marketcap vs RUNE',
    pt: '% de Marketcap vs RUNE',
    ja: 'RUNE時価総額に対する割合',
    zh: '占 RUNE 市值的百分比',
    ru: '% капитализации от RUNE',
    ko: 'RUNE 시가총액 대비 비율'
  },
  marketcapWord: {
    en: 'Marketcap',
    de: 'Marketcap',
    es: 'Marketcap',
    fr: 'Capitalisation',
    it: 'Marketcap',
    pt: 'Marketcap',
    ja: '時価総額',
    zh: '市值',
    ru: 'Капитализация',
    ko: '시가총액'
  },
  performanceLabel: {
    en: 'Performance',
    de: 'Performance',
    es: 'Rendimiento',
    fr: 'Performance',
    it: 'Performance',
    pt: 'Desempenho',
    ja: 'パフォーマンス',
    zh: '表现',
    ru: 'Динамика',
    ko: '성과'
  },
  tapToChange: {
    en: 'tap to change',
    de: 'zum Ändern tippen',
    es: 'toca para cambiar',
    fr: 'touchez pour changer',
    it: 'tocca per cambiare',
    pt: 'toque para alterar',
    ja: 'タップして変更',
    zh: '点击更改',
    ru: 'нажмите для изменения',
    ko: '탭하여 변경'
  },
  bondRewards: {
    en: 'Bond Rewards',
    de: 'Bond Rewards',
    es: 'Recompensas de Bond',
    fr: 'Récompenses de Bond',
    it: 'Ricompense Bond',
    pt: 'Recompensas de Bond',
    ja: 'ボンド報酬',
    zh: 'Bond 奖励',
    ru: 'Награды за бонд',
    ko: '본드 보상'
  },
  totalRewardsLabel: {
    en: 'Total',
    de: 'Gesamt',
    es: 'Total',
    fr: 'Total',
    it: 'Totale',
    pt: 'Total',
    ja: '合計',
    zh: '总计',
    ru: 'Всего',
    ko: '총계'
  },
  couldNotLoadRewardHistory: {
    en: 'Could not load reward history.',
    de: 'Rewards-Historie konnte nicht geladen werden.',
    es: 'No se pudo cargar el historial de recompensas.',
    fr: "Impossible de charger l'historique des récompenses.",
    it: 'Impossibile caricare la cronologia delle ricompense.',
    pt: 'Não foi possível carregar o histórico de recompensas.',
    ja: '報酬履歴を読み込めませんでした。',
    zh: '无法加载奖励历史记录。',
    ru: 'Не удалось загрузить историю наград.',
    ko: '보상 내역을 불러올 수 없습니다.'
  },
  calculating: {
    en: 'Calculating…',
    de: 'Wird berechnet…',
    es: 'Calculando…',
    fr: 'Calcul en cours…',
    it: 'Calcolo in corso…',
    pt: 'A calcular…',
    ja: '計算中…',
    zh: '计算中…',
    ru: 'Вычисление…',
    ko: '계산 중…'
  },
  accruedReward: {
    en: 'Accrued reward (this churn)',
    de: 'Aufgelaufener Reward (dieser Churn)',
    es: 'Recompensa acumulada (este churn)',
    fr: 'Récompense accumulée (ce churn)',
    it: 'Ricompensa maturata (questo churn)',
    pt: 'Recompensa acumulada (este churn)',
    ja: '発生報酬（今回のチャーン）',
    zh: '累计奖励（本次换届）',
    ru: 'Накопленная награда (этот чёрн)',
    ko: '누적 보상 (이번 churn)'
  },
  nextRewardLabel: {
    en: 'Next reward',
    de: 'Nächster Reward',
    es: 'Próxima recompensa',
    fr: 'Prochaine récompense',
    it: 'Prossima ricompensa',
    pt: 'Próxima recompensa',
    ja: '次の報酬',
    zh: '下次奖励',
    ru: 'Следующая награда',
    ko: '다음 보상'
  },
  churningHalted: {
    en: 'Halted',
    de: 'Pausiert',
    es: 'Pausado',
    fr: 'Suspendu',
    it: 'Sospeso',
    pt: 'Suspenso',
    ja: '停止中',
    zh: '已暂停',
    ru: 'Приостановлено',
    ko: '중지됨'
  },
  liveFromThornode: {
    en: 'Live from THORNode — grows every block, paid out at the next churn.',
    de: 'Live von THORNode — wächst mit jedem Block, wird beim nächsten Churn ausgezahlt.',
    es: 'En vivo desde THORNode — crece con cada bloque, se paga en el próximo churn.',
    fr: 'En direct depuis THORNode — augmente à chaque bloc, versé au prochain churn.',
    it: 'Live da THORNode — cresce a ogni blocco, pagato al prossimo churn.',
    pt: 'Ao vivo do THORNode — cresce a cada bloco, pago no próximo churn.',
    ja: 'THORNodeからのライブデータ — ブロックごとに増加し、次のチャーンで支払われます。',
    zh: '来自 THORNode 的实时数据 — 每个区块递增，将在下次换届时支付。',
    ru: 'Данные THORNode в реальном времени — растёт с каждым блоком, выплачивается при следующем чёрне.',
    ko: 'THORNode 실시간 데이터 — 블록마다 증가하며 다음 churn에서 지급됩니다.'
  },
  rewardsHistory: {
    en: 'Rewards History',
    de: 'Rewards-Historie',
    es: 'Historial de recompensas',
    fr: 'Historique des récompenses',
    it: 'Cronologia ricompense',
    pt: 'Histórico de recompensas',
    ja: '報酬履歴',
    zh: '奖励历史',
    ru: 'История наград',
    ko: '보상 내역'
  },
  downloadCsv: {
    en: 'Download as CSV',
    de: 'Als CSV herunterladen',
    es: 'Descargar como CSV',
    fr: 'Télécharger en CSV',
    it: 'Scarica come CSV',
    pt: 'Baixar como CSV',
    ja: 'CSVでダウンロード',
    zh: '下载为 CSV',
    ru: 'Скачать как CSV',
    ko: 'CSV로 다운로드'
  },
  exportMenuTitle: {
    en: 'Export',
    de: 'Exportieren',
    es: 'Exportar',
    fr: 'Exporter',
    it: 'Esporta',
    pt: 'Exportar',
    ja: 'エクスポート',
    zh: '导出',
    ru: 'Экспорт',
    ko: '내보내기'
  },
  downloadTaxReport: {
    en: 'Tax report (yearly summary, CSV)',
    de: 'Steuerbericht (Jahresübersicht, CSV)',
    es: 'Informe fiscal (resumen anual, CSV)',
    fr: 'Rapport fiscal (résumé annuel, CSV)',
    it: 'Rapporto fiscale (riepilogo annuale, CSV)',
    pt: 'Relatório fiscal (resumo anual, CSV)',
    ja: '税務レポート（年次まとめ、CSV）',
    zh: '税务报告（年度汇总，CSV）',
    ru: 'Налоговый отчёт (годовая сводка, CSV)',
    ko: '세금 보고서 (연간 요약, CSV)'
  },
  taxReportCsvTitle: {
    en: '# Tax report Bond Rewards -- NOT tax advice, data preparation only.',
    de: '# Steuerbericht Bond Rewards -- KEINE Steuerberatung, reine Datenaufbereitung.',
    es: '# Informe fiscal de recompensas de bond -- NO es asesoramiento fiscal, solo preparación de datos.',
    fr: '# Rapport fiscal des récompenses de bond -- PAS un conseil fiscal, simple préparation de données.',
    it: '# Rapporto fiscale sulle ricompense di bond -- NON è consulenza fiscale, solo preparazione dati.',
    pt: '# Relatório fiscal de recompensas de bond -- NÃO é aconselhamento fiscal, apenas preparação de dados.',
    ja: '# ボンド報酬 税務レポート -- 税務アドバイスではなく、単なるデータ整理です。',
    zh: '# Bond 奖励税务报告——非税务建议，仅为数据整理。',
    ru: 'Налоговый отчёт по наградам Bond -- НЕ является налоговой консультацией, только подготовка данных.',
    ko: '# 본드 리워드 세금 보고서 -- 세무 자문이 아닌 데이터 정리용입니다.'
  },
  taxReportCsvValuation: {
    en: '# Each reward valued at its historical price on the day it was received (Fair Market Value), currency: ',
    de: '# Bewertung je Reward zum historischen Kurs am Tag des Zuflusses (Fair Market Value), Waehrung: ',
    es: '# Cada recompensa valorada a su precio histórico el día de recepción (valor justo de mercado), moneda: ',
    fr: '# Chaque récompense évaluée à son prix historique le jour de réception (juste valeur marchande), devise : ',
    it: '# Ogni ricompensa valutata al prezzo storico del giorno di ricezione (Fair Market Value), valuta: ',
    pt: '# Cada recompensa avaliada ao preço histórico no dia do recebimento (Fair Market Value), moeda: ',
    ja: '# 各報酬は受領日の historical 価格（公正市場価値）で評価。通貨: ',
    zh: '# 每笔奖励按到账当日的历史价格计价（公允市场价值），货币：',
    ru: '# Каждая награда оценена по историческому курсу на день зачисления (справедливая рыночная стоимость), валюта: ',
    ko: '# 각 보상은 수령일의 과거 시세(공정 시장 가치)로 평가됨, 통화: '
  },
  taxReportCsvCreatedAt: {
    en: '# Created on: ',
    de: '# Erstellt am: ',
    es: '# Creado el: ',
    fr: '# Créé le : ',
    it: '# Creato il: ',
    pt: '# Criado em: ',
    ja: '# 作成日: ',
    zh: '# 生成时间：',
    ru: '# Создано: ',
    ko: '# 생성일: '
  },
  fetchingRewardHistory: {
    en: 'Fetching reward history from THORNode…',
    de: 'Lade Reward-Historie von THORNode…',
    es: 'Obteniendo historial de recompensas de THORNode…',
    fr: "Récupération de l'historique des récompenses depuis THORNode…",
    it: 'Recupero della cronologia ricompense da THORNode…',
    pt: 'A obter histórico de recompensas do THORNode…',
    ja: 'THORNodeから報酬履歴を取得中…',
    zh: '正在从 THORNode 获取奖励历史…',
    ru: 'Загрузка истории наград из THORNode…',
    ko: 'THORNode에서 보상 내역 가져오는 중…'
  },
  allEntriesVerified: {
    en: 'entries verified directly from THORNode.',
    de: 'Einträge direkt von THORNode verifiziert.',
    es: 'entradas verificadas directamente desde THORNode.',
    fr: 'entrées vérifiées directement depuis THORNode.',
    it: 'voci verificate direttamente da THORNode.',
    pt: 'entradas verificadas diretamente do THORNode.',
    ja: '件のエントリがTHORNodeから直接検証されました。',
    zh: '条记录已直接通过 THORNode 验证。',
    ru: 'записей проверено напрямую через THORNode.',
    ko: '개 항목이 THORNode에서 직접 확인되었습니다.'
  },
  totalAboveAccurate: {
    en: 'Total above is accurate; the per-churn breakdown below could not be fetched right now.',
    de: 'Die Summe oben stimmt; die Einzelaufschlüsselung unten konnte gerade nicht geladen werden.',
    es: 'El total de arriba es correcto; el desglose por churn no se pudo cargar ahora.',
    fr: "Le total ci-dessus est exact ; la répartition par churn n'a pas pu être chargée pour le moment.",
    it: 'Il totale sopra è corretto; il dettaglio per churn non è stato caricato al momento.',
    pt: 'O total acima está correto; o detalhe por churn não pôde ser carregado agora.',
    ja: '上記の合計は正確です。churn毎の内訳は現在取得できませんでした。',
    zh: '上方总额准确；下方的逐次换届明细暂时无法加载。',
    ru: 'Итог выше верен; разбивку по чёрнам сейчас загрузить не удалось.',
    ko: '위 합계는 정확합니다. 아래의 churn별 내역은 지금 불러올 수 없습니다.'
  },
  networkApyChurn: {
    en: 'APY',
    de: 'APY',
    es: 'APY',
    fr: 'APY',
    it: 'APY',
    pt: 'APY',
    ja: 'APY',
    zh: 'APY',
    ru: 'APY',
    ko: 'APY'
  },
  networkApyExact: {
    en: 'Compounded from real historical rewards and bond flows — not estimated.',
    de: 'Compoundet aus echten historischen Rewards und Bond-Bewegungen — keine Schätzung.',
    es: 'Compuesto a partir de recompensas y movimientos de bond históricos reales — no estimado.',
    fr: "Composé à partir de récompenses et de mouvements de bond historiques réels — non estimé.",
    it: 'Composto da rewards e movimenti di bond storici reali — non stimato.',
    pt: 'Composto a partir de recompensas e movimentos de bond históricos reais — não estimado.',
    ja: '実際の過去の報酬とボンド増減から複利計算 — 推定値ではありません。',
    zh: '基于真实历史奖励和绑定资金变动复利计算——非估算值。',
    ru: 'Рассчитано с капитализацией на основе реальных исторических наград и движений бонда — не оценка.',
    ko: '실제 과거 리워드와 본드 이동을 복리로 계산 — 추정치가 아닙니다.'
  },
  atWord: {
    en: '@',
    de: 'zu',
    es: 'a',
    fr: 'à',
    it: 'a',
    pt: 'a',
    ja: '価格',
    zh: '价格为',
    ru: 'по',
    ko: '가격'
  },
  couldNotVerifyIndividual: {
    en: 'Could not verify individual reward events right now. The total above is still accurate.',
    de: 'Die einzelnen Reward-Ereignisse konnten gerade nicht verifiziert werden. Die Summe oben stimmt trotzdem.',
    es: 'No se pudieron verificar los eventos de recompensa individuales ahora. El total de arriba sigue siendo correcto.',
    fr: "Impossible de vérifier les événements de récompense individuels pour le moment. Le total ci-dessus reste exact.",
    it: 'Impossibile verificare i singoli eventi di ricompensa ora. Il totale sopra resta corretto.',
    pt: 'Não foi possível verificar os eventos de recompensa individuais agora. O total acima continua correto.',
    ja: '個々の報酬イベントを現在確認できませんでした。上記の合計は正確です。',
    zh: '暂时无法验证各条奖励记录，上方总额依然准确。',
    ru: 'Не удалось проверить отдельные события наград сейчас. Итог выше по-прежнему верен.',
    ko: '개별 보상 이벤트를 지금 확인할 수 없습니다. 위 합계는 여전히 정확합니다.'
  },
  noRewardEvents: {
    en: 'No reward events recorded yet.',
    de: 'Noch keine Reward-Einträge erfasst.',
    es: 'Aún no hay eventos de recompensa registrados.',
    fr: "Aucun événement de récompense enregistré pour l'instant.",
    it: 'Nessun evento di ricompensa registrato ancora.',
    pt: 'Ainda não há eventos de recompensa registados.',
    ja: '報酬イベントはまだ記録されていません。',
    zh: '尚无奖励记录。',
    ru: 'Пока нет зарегистрированных наград.',
    ko: '아직 기록된 보상 이벤트가 없습니다.'
  },
  searchWord: {
    en: 'Search',
    de: 'Suchen',
    es: 'Buscar',
    fr: 'Rechercher',
    it: 'Cerca',
    pt: 'Pesquisar',
    ja: '検索',
    zh: '搜索',
    ru: 'Поиск',
    ko: '검색'
  },
  addWallet: {
    en: 'Add',
    de: 'Hinzufügen',
    es: 'Añadir',
    fr: 'Ajouter',
    it: 'Aggiungi',
    pt: 'Adicionar',
    ja: '追加',
    zh: '添加',
    ru: 'Добавить',
    ko: '추가'
  },
  addAnotherWallet: {
    en: 'Add another wallet…',
    de: 'Weitere Wallet hinzufügen…',
    es: 'Añadir otra cartera…',
    fr: 'Ajouter un autre portefeuille…',
    it: "Aggiungi un altro portafoglio…",
    pt: 'Adicionar outra carteira…',
    ja: '別のウォレットを追加…',
    zh: '添加另一个钱包…',
    ru: 'Добавить ещё кошелёк…',
    ko: '다른 지갑 추가…'
  },
  removeWallet: {
    en: 'Remove wallet',
    de: 'Wallet entfernen',
    es: 'Eliminar cartera',
    fr: 'Supprimer le portefeuille',
    it: 'Rimuovi portafoglio',
    pt: 'Remover carteira',
    ja: 'ウォレットを削除',
    zh: '移除钱包',
    ru: 'Удалить кошелёк',
    ko: '지갑 제거'
  },
  walletsWord: {
    en: 'Wallets',
    de: 'Wallets',
    es: 'Carteras',
    fr: 'Portefeuilles',
    it: 'Portafogli',
    pt: 'Carteiras',
    ja: 'ウォレット',
    zh: '钱包',
    ru: 'Кошельки',
    ko: '지갑'
  },
  addWalletsHeader: {
    en: 'Add Wallets',
    de: 'Wallets hinzufügen',
    es: 'Añadir carteras',
    fr: 'Ajouter des portefeuilles',
    it: 'Aggiungi portafogli',
    pt: 'Adicionar carteiras',
    ja: 'ウォレットを追加',
    zh: '添加钱包',
    ru: 'Добавить кошельки',
    ko: '지갑 추가'
  },
  addWalletsHeaderShort: {
    en: 'Wallets',
    de: 'Wallets',
    es: 'Carteras',
    fr: 'Portefeuilles',
    it: 'Portafogli',
    pt: 'Carteiras',
    ja: 'ウォレット',
    zh: '钱包',
    ru: 'Кошельки',
    ko: '지갑'
  },
  enterAddressPrompt: {
    en: 'Enter your THORChain address to see your portfolio value and history.',
    de: 'Gib deine THORChain-Adresse ein, um deinen Portfolio-Wert und den Verlauf zu sehen.',
    es: 'Introduce tu dirección de THORChain para ver el valor y el historial de tu cartera.',
    fr: 'Entrez votre adresse THORChain pour voir la valeur et l\'historique de votre portefeuille.',
    it: 'Inserisci il tuo indirizzo THORChain per vedere il valore e la cronologia del tuo portafoglio.',
    pt: 'Introduza o seu endereço THORChain para ver o valor e o histórico da sua carteira.',
    ja: 'THORChainアドレスを入力して、ポートフォリオの価値と履歴を確認してください。',
    zh: '输入您的 THORChain 地址以查看投资组合价值和历史记录。',
    ru: 'Введите свой адрес THORChain, чтобы увидеть стоимость портфеля и историю.',
    ko: 'THORChain 주소를 입력하여 포트폴리오 가치와 내역을 확인하세요.'
  },
  chartTab: {
    en: 'Portfolio',
    de: 'Portfolio',
    es: 'Portafolio',
    fr: 'Portefeuille',
    it: 'Portafoglio',
    pt: 'Carteira',
    ja: 'ポートフォリオ',
    zh: '投资组合',
    ru: 'Портфель',
    ko: '포트폴리오'
  },
  detailsTab: {
    en: 'Additional details',
    de: 'Zusätzliche Details',
    es: 'Detalles adicionales',
    fr: 'Détails supplémentaires',
    it: 'Dettagli aggiuntivi',
    pt: 'Detalhes adicionais',
    ja: '追加情報',
    zh: '更多详情',
    ru: 'Дополнительные сведения',
    ko: '추가 세부정보'
  },
  portfolioValue: {
    en: 'Portfolio Value',
    de: 'Portfolio-Wert',
    es: 'Valor de la cartera',
    fr: 'Valeur du portefeuille',
    it: 'Valore del portafoglio',
    pt: 'Valor da carteira',
    ja: 'ポートフォリオ価値',
    zh: '投资组合价值',
    ru: 'Стоимость портфеля',
    ko: '포트폴리오 가치'
  },
  changeCurrency: {
    en: 'Change currency',
    de: 'Währung ändern',
    es: 'Cambiar moneda',
    fr: 'Changer de devise',
    it: 'Cambia valuta',
    pt: 'Mudar moeda',
    ja: '通貨を変更',
    zh: '更改货币',
    ru: 'Изменить валюту',
    ko: '통화 변경'
  },
  showValues: {
    en: 'Show values',
    de: 'Werte einblenden',
    es: 'Mostrar valores',
    fr: 'Afficher les valeurs',
    it: 'Mostra valori',
    pt: 'Mostrar valores',
    ja: '値を表示',
    zh: '显示数值',
    ru: 'Показать значения',
    ko: '값 표시'
  },
  hideValues: {
    en: 'Hide values',
    de: 'Werte verbergen',
    es: 'Ocultar valores',
    fr: 'Masquer les valeurs',
    it: 'Nascondi valori',
    pt: 'Ocultar valores',
    ja: '値を非表示',
    zh: '隐藏数值',
    ru: 'Скрыть значения',
    ko: '값 숨기기'
  },
  refreshWord: {
    en: 'Refresh',
    de: 'Aktualisieren',
    es: 'Actualizar',
    fr: 'Actualiser',
    it: 'Aggiorna',
    pt: 'Atualizar',
    ja: '更新',
    zh: '刷新',
    ru: 'Обновить',
    ko: '새로고침'
  },
  totalRuneWord: {
    en: 'Total RUNE',
    de: 'Gesamt RUNE',
    es: 'Total RUNE',
    fr: 'Total RUNE',
    it: 'Totale RUNE',
    pt: 'Total RUNE',
    ja: '合計RUNE',
    zh: 'RUNE 总量',
    ru: 'Всего RUNE',
    ko: '총 RUNE'
  },
  showNodeBreakdown: {
    en: 'Bonded per node',
    de: 'Bonded pro Node',
    es: 'Bond por node',
    fr: 'Bond par node',
    it: 'Bond per node',
    pt: 'Bond por node',
    ja: 'ノード別ボンド',
    zh: '按节点分布',
    ru: 'Бонд по нодам',
    ko: '노드별 본드'
  },
  showNodeBreakdownShort: {
    en: 'Per node',
    de: 'Pro Node',
    es: 'Por node',
    fr: 'Par node',
    it: 'Per node',
    pt: 'Por node',
    ja: 'ノード別',
    zh: '按节点',
    ru: 'По нодам',
    ko: '노드별'
  },
  lastUpdated: {
    en: 'Last updated: ',
    de: 'Zuletzt aktualisiert: ',
    es: 'Última actualización: ',
    fr: 'Dernière mise à jour : ',
    it: 'Ultimo aggiornamento: ',
    pt: 'Última atualização: ',
    ja: '最終更新: ',
    zh: '最后更新：',
    ru: 'Обновлено: ',
    ko: '마지막 업데이트: '
  },
  volume24h: {
    en: '24h Volume',
    de: '24h Volumen',
    es: 'Volumen 24h',
    fr: 'Volume 24h',
    it: 'Volume 24h',
    pt: 'Volume 24h',
    ja: '24時間出来高',
    zh: '24小时交易量',
    ru: 'Объём за 24ч',
    ko: '24시간 거래량'
  },
  volumeWord: {
    en: 'Volume',
    de: 'Volumen',
    es: 'Volumen',
    fr: 'Volume',
    it: 'Volume',
    pt: 'Volume',
    ja: '出来高',
    zh: '成交量',
    ru: 'Объём',
    ko: '거래량'
  },
  swapVolumeLabel: {
    en: 'THORChain swap volume',
    de: 'THORChain-Swap-Volumen',
    es: 'Volumen de swaps THORChain',
    fr: 'Volume de swaps THORChain',
    it: 'Volume di swap THORChain',
    pt: 'Volume de swaps THORChain',
    ja: 'THORChainスワップ出来高',
    zh: 'THORChain 兑换量',
    ru: 'Объём свопов THORChain',
    ko: 'THORChain 스왑 거래량'
  },
  tradingVolumeLabel: {
    en: 'RUNE trading volume (exchanges & DEXs)',
    de: 'RUNE-Handelsvolumen (Börsen & DEXes)',
    es: 'Volumen de negociación de RUNE (exchanges y DEX)',
    fr: 'Volume d\u2019échange de RUNE (bourses et DEX)',
    it: 'Volume di scambio RUNE (exchange e DEX)',
    pt: 'Volume de negociação do RUNE (exchanges e DEX)',
    ja: 'RUNE取引量（取引所＆DEX）',
    zh: 'RUNE 交易量（交易所和 DEX）',
    ru: 'Объём торгов RUNE (биржи и DEX)',
    ko: 'RUNE 거래량 (거래소 및 DEX)'
  },
  swapHere: {
    en: 'Swap here',
    de: 'Swap here',
    es: 'Intercambia aquí',
    fr: 'Échanger ici',
    it: 'Scambia qui',
    pt: 'Trocar aqui',
    ja: 'ここでスワップ',
    zh: '在此兑换',
    ru: 'Обменять здесь',
    ko: '여기서 스왑'
  },
  bondedNoteBefore: {
    en: 'Note: Bonded',
    de: 'Hinweis: Bonded',
    es: 'Nota: Bonded',
    fr: 'Remarque : Bonded',
    it: 'Nota: Bonded',
    pt: 'Nota: Bonded',
    ja: '注: ボンド',
    zh: '提示：Bonded',
    ru: 'Примечание: Bonded',
    ko: '참고: Bonded'
  },
  bondedNoteAfter: {
    en: 'could not be retrieved (node list unreachable) — only available balance is shown.',
    de: 'konnte nicht abgefragt werden (Node-Liste nicht erreichbar) — nur verfügbare Balance wird angezeigt.',
    es: 'no se pudo obtener (lista de nodos inaccesible) — solo se muestra el saldo disponible.',
    fr: "n'a pas pu être récupéré (liste des nodes inaccessible) — seul le solde disponible est affiché.",
    it: 'non è stato possibile recuperarlo (elenco nodi non raggiungibile) — viene mostrato solo il saldo disponibile.',
    pt: 'não pôde ser obtido (lista de nós inacessível) — apenas o saldo disponível é mostrado.',
    ja: 'を取得できませんでした（ノードリストに到達不可）— 利用可能残高のみ表示されます。',
    zh: '无法获取（节点列表不可达）— 仅显示可用余额。',
    ru: 'не удалось получить (список узлов недоступен) — показан только доступный баланс.',
    ko: '을(를) 가져올 수 없습니다 (노드 목록에 연결할 수 없음) — 사용 가능한 잔액만 표시됩니다.'
  },
  priceDataError: {
    en: 'Could not load price data from CoinGecko or Binance (possibly rate-limited or a network error). Please wait a moment and try again.',
    de: 'Preisdaten konnten weder von CoinGecko noch von Binance geladen werden (evtl. Rate-Limit oder Netzwerkfehler). Bitte kurz warten und erneut versuchen.',
    es: 'No se pudieron cargar los datos de precio desde CoinGecko ni Binance (posible límite de tasa o error de red). Espera un momento e inténtalo de nuevo.',
    fr: "Impossible de charger les données de prix depuis CoinGecko ou Binance (limite de requêtes ou erreur réseau possible). Veuillez patienter puis réessayer.",
    it: 'Impossibile caricare i dati sui prezzi da CoinGecko o Binance (possibile limite di frequenza o errore di rete). Attendi un momento e riprova.',
    pt: 'Não foi possível carregar os dados de preço do CoinGecko ou da Binance (possível limite de taxa ou erro de rede). Aguarde um momento e tente novamente.',
    ja: 'CoinGeckoまたはBinanceから価格データを読み込めませんでした（レート制限またはネットワークエラーの可能性）。しばらく待って再試行してください。',
    zh: '无法从 CoinGecko 或 Binance 加载价格数据（可能是速率限制或网络错误）。请稍等片刻后重试。',
    ru: 'Не удалось загрузить данные о цене с CoinGecko или Binance (возможно, ограничение частоты запросов или ошибка сети). Подождите немного и повторите попытку.',
    ko: 'CoinGecko 또는 Binance에서 가격 데이터를 불러올 수 없습니다 (속도 제한 또는 네트워크 오류일 수 있음). 잠시 후 다시 시도해 주세요.'
  },
  nodeTooltip: {
    en: 'Node overview & my notifications',
    de: 'Node-Übersicht & eigene Benachrichtigungen',
    es: 'Resumen de nodos y mis notificaciones',
    fr: 'Aperçu des nodes et mes notifications',
    it: 'Panoramica node e mie notifiche',
    pt: 'Visão geral dos nodes e minhas notificações',
    ja: 'ノード概要と通知',
    zh: '节点概览与我的通知',
    ru: 'Обзор нод и мои уведомления',
    ko: '노드 개요 및 내 알림'
  },
  nodeActiveLabel: {
    en: 'Active',
    de: 'Aktiv',
    es: 'Activos',
    fr: 'Actifs',
    it: 'Attivi',
    pt: 'Ativos',
    ja: 'アクティブ',
    zh: '活跃',
    ru: 'Активные',
    ko: '활성'
  },
  nodeJoiningLabel: {
    en: 'Ready to join',
    de: 'Rein',
    es: 'Listos para unirse',
    fr: 'Prêts à entrer',
    it: 'Pronti a entrare',
    pt: 'Prontos para entrar',
    ja: '参加待ち',
    zh: '待加入',
    ru: 'Готовы войти',
    ko: '가입 대기'
  },
  nodeLeavingLabel: {
    en: 'Out',
    de: 'Raus',
    es: 'Salen',
    fr: 'Sortent',
    it: 'Escono',
    pt: 'Saem',
    ja: '離脱',
    zh: '离开',
    ru: 'Уходят',
    ko: '탈퇴'
  },
  nodeNoWalletHint: {
    en: 'Add a wallet to see notifications for your own nodes.',
    de: 'Wallet hinzufügen, um eigene Node-Änderungen zu sehen.',
    es: 'Añade una cartera para ver notificaciones de tus propios nodos.',
    fr: 'Ajoutez un portefeuille pour voir les notifications de vos propres nodes.',
    it: 'Aggiungi un portafoglio per vedere le notifiche dei tuoi node.',
    pt: 'Adicione uma carteira para ver notificações dos seus próprios nodes.',
    ja: 'ウォレットを追加すると、自分のノードの通知が表示されます。',
    zh: '添加钱包以查看您自己节点的通知。',
    ru: 'Добавьте кошелёк, чтобы видеть уведомления о своих нодах.',
    ko: '지갑을 추가하면 내 노드의 알림을 볼 수 있습니다.'
  },
  nodeNoChangesHint: {
    en: 'No changes detected yet.',
    de: 'Noch keine Änderungen erkannt.',
    es: 'Aún no se han detectado cambios.',
    fr: 'Aucun changement détecté pour le moment.',
    it: 'Nessuna modifica rilevata finora.',
    pt: 'Ainda não foram detetadas alterações.',
    ja: 'まだ変更は検出されていません。',
    zh: '尚未检测到变化。',
    ru: 'Изменений пока не обнаружено.',
    ko: '아직 감지된 변경 사항이 없습니다.'
  },
  nodeMarkAllRead: {
    en: 'Mark all as read',
    de: 'Als gelesen markieren',
    es: 'Marcar todo como leído',
    fr: 'Marquer tout comme lu',
    it: 'Segna tutto come letto',
    pt: 'Marcar tudo como lido',
    ja: 'すべて既読にする',
    zh: '标记为已读',
    ru: 'Отметить как прочитанное',
    ko: '모두 읽음으로 표시'
  },
  nodeNowActive: {
    en: 'Your node is now active (churned in)',
    de: 'ist jetzt aktiv (gechurnt)',
    es: 'ahora está activo (churn de entrada)',
    fr: 'est maintenant actif (churn entrant)',
    it: 'è ora attivo (churn in entrata)',
    pt: 'agora está ativo (churn de entrada)',
    ja: '今アクティブになりました（チャーンイン）',
    zh: '现在已激活（换届加入）',
    ru: 'теперь активна (вошла в чёрн)',
    ko: '지금 활성화되었습니다 (churn 진입)'
  },
  nodeLeftActiveSet: {
    en: 'left the active set',
    de: 'hat den aktiven Set verlassen',
    es: 'salió del conjunto activo',
    fr: "a quitté l'ensemble actif",
    it: "ha lasciato l'insieme attivo",
    pt: 'saiu do conjunto ativo',
    ja: 'アクティブセットから離脱しました',
    zh: '已离开活跃集合',
    ru: 'покинула активный набор',
    ko: '활성 세트에서 나갔습니다'
  },
  nodeLeaveRequested: {
    en: 'requested to leave',
    de: 'wurde "Leave" beantragt für',
    es: 'solicitó salir',
    fr: 'a demandé à quitter',
    it: 'ha richiesto di uscire',
    pt: 'solicitou sair',
    ja: 'は離脱を申請しました',
    zh: '已申请离开',
    ru: 'запросила выход',
    ko: '탈퇴를 요청했습니다'
  },
  nodeChurnOutCandidate: {
    en: 'is a churn-out candidate',
    de: 'ist Churn-Out-Kandidat',
    es: 'es candidato a salir en el churn',
    fr: 'est candidat à la sortie',
    it: 'è candidato al churn-out',
    pt: 'é candidato a sair no churn',
    ja: 'はチャーンアウト候補です',
    zh: '是换届淘汰候选',
    ru: 'кандидат на выход',
    ko: 'churn-out 후보입니다'
  },
  nodeYourNode: {
    en: 'Your node',
    de: 'Deine Node',
    es: 'Tu node',
    fr: 'Votre node',
    it: 'Il tuo node',
    pt: 'Seu node',
    ja: 'あなたのノード',
    zh: '你的节点',
    ru: 'Твоя нода',
    ko: '내 노드'
  },
  nodeLeaveTypeForced: {
    en: 'being force-removed',
    de: 'wird zwangsweise entfernt',
    es: 'está siendo eliminado forzosamente',
    fr: 'est retiré de force',
    it: 'viene rimosso forzatamente',
    pt: 'está a ser removido à força',
    ja: '強制的に除外されます',
    zh: '将被强制移除',
    ru: 'принудительно удаляется',
    ko: '강제로 제거되는 중'
  },
  nodeLeaveTypeOldest: {
    en: 'the oldest active node',
    de: 'die älteste aktive Node',
    es: 'el node activo más antiguo',
    fr: 'le node actif le plus ancien',
    it: 'il node attivo più vecchio',
    pt: 'o node ativo mais antigo',
    ja: '最も古いアクティブノード',
    zh: '最旧的活跃节点',
    ru: 'самая старая активная нода',
    ko: '가장 오래된 활성 노드'
  },
  nodeLeaveTypeWorst: {
    en: 'has the most slash points',
    de: 'hat die meisten Slash Points',
    es: 'tiene más puntos de penalización',
    fr: 'a le plus de points de pénalité',
    it: 'ha più slash points',
    pt: 'tem mais pontos de penalização',
    ja: 'スラッシュポイントが最多です',
    zh: '惩罚积分最多',
    ru: 'больше всего штрафных баллов',
    ko: '슬래시 포인트가 가장 많음'
  },
  nodeLeaveTypeLowest: {
    en: 'has the lowest bond',
    de: 'hat den niedrigsten Bond',
    es: 'tiene el bond más bajo',
    fr: 'a le bond le plus faible',
    it: 'ha il bond più basso',
    pt: 'tem o bond mais baixo',
    ja: 'ボンドが最も低いです',
    zh: '绑定金额最低',
    ru: 'наименьший бонд',
    ko: '본드가 가장 낮음'
  },
  nodesActiveSuffix: {
    en: 'nodes active',
    de: 'Nodes aktiv',
    es: 'nodes activos',
    fr: 'nodes actifs',
    it: 'node attivi',
    pt: 'nodes ativos',
    ja: 'ノードがアクティブ',
    zh: '个节点活跃',
    ru: 'нод активно',
    ko: '개 노드 활성'
  },
  nodesJoiningSuffix: {
    en: 'ready to join',
    de: 'wollen rein',
    es: 'listos para unirse',
    fr: 'prêts à entrer',
    it: 'pronti a entrare',
    pt: 'prontos para entrar',
    ja: '参加待ち',
    zh: '待加入',
    ru: 'готовы войти',
    ko: '가입 대기'
  },
  nodesJoiningSuffixShort: {
    en: 'joining',
    de: 'rein',
    es: 'entrando',
    fr: 'entrant',
    it: 'in entrata',
    pt: 'entrando',
    ja: '参加',
    zh: '加入',
    ru: 'входят',
    ko: '가입'
  },
  nodesLeavingSuffix: {
    en: 'want/must leave',
    de: 'wollen/müssen raus',
    es: 'quieren/deben salir',
    fr: 'veulent/doivent sortir',
    it: 'vogliono/devono uscire',
    pt: 'querem/devem sair',
    ja: '離脱予定',
    zh: '想/必须离开',
    ru: 'хотят/должны уйти',
    ko: '탈퇴 예정'
  },
  nodesLeavingSuffixShort: {
    en: 'leaving',
    de: 'raus',
    es: 'saliendo',
    fr: 'sortant',
    it: 'in uscita',
    pt: 'saindo',
    ja: '離脱',
    zh: '离开',
    ru: 'уходят',
    ko: '탈퇴'
  },
  donate: {
    en: 'Donate',
    de: 'Spenden'
  },
  donateCopied: {
    en: 'Address copied',
    de: 'Adresse kopiert'
  },
  donateAssetsThorchain: {
    de: 'Nimmt RUNE und andere native THORChain-Assets an',
    en: 'Accepts RUNE and other native THORChain assets',
    es: 'Acepta RUNE y otros activos nativos de THORChain',
    fr: 'Accepte RUNE et d\u2019autres actifs natifs de THORChain',
    it: 'Accetta RUNE e altri asset nativi di THORChain',
    pt: 'Aceita RUNE e outros ativos nativos da THORChain',
    ja: 'RUNEおよびその他のTHORChainネイティブ資産に対応',
    zh: '支持 RUNE 及其他 THORChain 原生资产',
    ru: 'Принимает RUNE и другие нативные активы THORChain',
    ko: 'RUNE 및 기타 THORChain 네이티브 자산 지원'
  },
  donateAssetsEthereum: {
    de: 'Nimmt ETH und ERC-20-Token an (z. B. USDC, USDT)',
    en: 'Accepts ETH and ERC-20 tokens (e.g. USDC, USDT)',
    es: 'Acepta ETH y tokens ERC-20 (p. ej. USDC, USDT)',
    fr: 'Accepte ETH et les tokens ERC-20 (ex. USDC, USDT)',
    it: 'Accetta ETH e token ERC-20 (es. USDC, USDT)',
    pt: 'Aceita ETH e tokens ERC-20 (ex.: USDC, USDT)',
    ja: 'ETHおよびERC-20トークン（USDC、USDTなど）に対応',
    zh: '支持 ETH 及 ERC-20 代币（如 USDC、USDT）',
    ru: 'Принимает ETH и токены ERC-20 (напр. USDC, USDT)',
    ko: 'ETH 및 ERC-20 토큰 지원 (예: USDC, USDT)'
  },
  donateHint: {
    en: 'Show donation addresses',
    de: 'Spendenadressen anzeigen'
  },
  donateCopyHint: {
    en: 'Click to copy',
    de: 'Klicken zum Kopieren'
  },
  donateCopyAction: {
    en: 'Copy',
    de: 'Kopieren'
  },
  donateText: {
    de: 'Danke für deine Unterstützung ♥',
    en: 'Thank you for your support ♥',
    es: 'Gracias por tu apoyo ♥',
    fr: 'Merci pour votre soutien ♥',
    it: 'Grazie per il tuo supporto ♥',
    pt: 'Obrigado pelo teu apoio ♥',
    ja: 'ご支援ありがとうございます ♥',
    zh: '感谢你的支持 ♥',
    ru: 'Спасибо за вашу поддержку ♥',
    ko: '응원해 주셔서 감사합니다 ♥'
  },
  avgBuyPrice: {
    en: 'Avg. buy price',
    de: 'Ø Kaufpreis'
  },
  costBasisAverage: {
    en: 'Average',
    de: 'Ø Preis'
  },
  costBasisFifo: {
    en: 'FIFO',
    de: 'FIFO'
  },
  costBasisMethodHint: {
    en: 'Average: weighted average cost across everything held. FIFO: oldest purchases count as sold first. Different countries require different methods for tax purposes — this is not tax advice.',
    de: 'Ø Preis: gewichteter Durchschnitt über den gesamten gehaltenen Bestand. FIFO: die zuerst gekauften Coins gelten zuerst als verkauft. Verschiedene Länder schreiben für Steuerzwecke unterschiedliche Methoden vor — dies ist keine Steuerberatung.'
  },
  rewardsOnlyZeroHint: {
    en: 'Your whole stack comes from bond rewards, which count as $0 under "Rewards free" — hence an average price of $0.00. Switch to "Rewards @ market" to value them at the price when they were received, or add your purchases below.',
    de: 'Dein gesamter Bestand stammt aus Bond-Rewards, die bei "Rewards frei" mit 0 $ zählen — daher der Ø-Preis von 0,00 $. Für eine Bewertung zum Kurs bei Erhalt auf "Rewards @ Markt" umschalten, oder unten eigene Käufe ergänzen.'
  },
  rewardValuationFree: {
    en: 'Rewards free',
    de: 'Rewards frei'
  },
  rewardValuationMarket: {
    en: 'Rewards @ market',
    de: 'Rewards @ Markt'
  },
  rewardValuationHint: {
    en: 'How bond/staking rewards count toward your cost basis. "Free": rewards cost $0, diluting your average price. "@ market": rewards are valued at the historical price when received — the same prices used in the rewards CSV export, and closer to how many countries tax staking income. Not tax advice.',
    de: 'Wie Bond-/Staking-Rewards in die Kostenbasis einfließen. "Frei": Rewards kosten 0 $, verdünnen den Ø-Preis. "@ Markt": Rewards werden zum historischen Kurs bei Erhalt bewertet — dieselben Preise wie im Rewards-CSV-Export, und näher an der steuerlichen Behandlung von Staking-Einkommen in vielen Ländern. Keine Steuerberatung.'
  },
  addPurchase: {
    en: 'Add purchase',
    de: 'Kauf hinzufügen'
  },
  editPurchase: {
    en: 'Edit purchase',
    de: 'Kauf bearbeiten'
  },
  noPurchasesYet: {
    en: 'No purchases tracked yet.',
    de: 'Noch keine Käufe erfasst.'
  },
  noPurchasesHint: {
    en: 'Add every RUNE purchase (from any exchange or DEX) to see your true average buy price and P/L.',
    de: 'Erfasse jeden RUNE-Kauf (egal ob Börse oder DEX), um deinen echten Ø-Kaufpreis und Gewinn/Verlust zu sehen.'
  },
  invested: {
    en: 'Invested',
    de: 'Investiert'
  },
  currentlyHeld: {
    en: 'Currently held',
    de: 'Aktuell gehalten'
  },
  realizedPnl: {
    en: 'Realized (from sells)',
    de: 'Realisiert (aus Verkäufen)'
  },
  includesRewards: {
    en: 'Includes {n} RUNE from bond rewards (counted at $0 cost)',
    de: 'Enthält {n} RUNE aus Bond-Rewards (mit $0 Kosten gerechnet)'
  },
  includesRewardsShort: {
    en: 'Rewards included',
    de: 'Rewards enthalten'
  },
  bondRewardsLabel: {
    en: 'Bond rewards',
    de: 'Bond-Rewards'
  },
  currentValueLabel: {
    en: 'Current value',
    de: 'Aktueller Wert'
  },
  profitLoss: {
    en: 'Profit / loss',
    de: 'Gewinn / Verlust'
  },
  purchaseDate: {
    en: 'Date',
    de: 'Datum'
  },
  purchaseAmount: {
    en: 'Amount (RUNE)',
    de: 'Menge (RUNE)'
  },
  purchaseMode: {
    en: 'Enter as',
    de: 'Eingabe als'
  },
  purchaseModePrice: {
    en: 'Price per RUNE',
    de: 'Preis pro RUNE'
  },
  purchaseModeTotal: {
    en: 'Total paid',
    de: 'Gesamtbetrag'
  },
  txTypeBuy: {
    en: 'Buy',
    de: 'Kauf'
  },
  txTypeSell: {
    en: 'Sell',
    de: 'Verkauf'
  },
  purchaseSource: {
    en: 'Source',
    de: 'Quelle'
  },
  purchaseSave: {
    en: 'Save',
    de: 'Speichern'
  },
  purchaseCancel: {
    en: 'Cancel',
    de: 'Abbrechen'
  },
  purchaseImportCsv: {
    en: 'Import CSV',
    de: 'CSV importieren'
  },
  csvImportLoading: {
    en: 'Importing… (fetching historical rates for non-USD prices)',
    de: 'Importiere… (historische Kurse für Fremdwährungs-Preise werden abgerufen)'
  },
  purchaseImportHint: {
    en: 'Works with exported trade history from most exchanges (needs date, amount and price or total columns).',
    de: 'Funktioniert mit exportierter Handelshistorie der meisten Börsen (braucht Spalten für Datum, Menge und Preis oder Gesamtbetrag).'
  },
  csvImportNoRows: {
    en: 'No usable rows found in this file.',
    de: 'Keine verwertbaren Zeilen in dieser Datei gefunden.'
  },
  csvImportPartial: {
    en: '{n} row(s) could not be read and were skipped.',
    de: '{n} Zeile(n) konnten nicht gelesen werden und wurden übersprungen.'
  },
  csvImportFailed: {
    en: 'Could not read this file.',
    de: 'Diese Datei konnte nicht gelesen werden.'
  },
  csvImportAllDuplicates: {
    en: 'All rows in this file were already imported before.',
    de: 'Alle Zeilen dieser Datei waren bereits importiert.'
  },
  csvImportDuplicatesSkipped: {
    en: '{n} duplicate row(s) skipped.',
    de: '{n} bereits vorhandene Zeile(n) übersprungen.'
  },
  showHistory: {
    en: 'Show history',
    de: 'Verlauf anzeigen'
  },
  hideHistory: {
    en: 'Hide history',
    de: 'Verlauf ausblenden'
  },
  purchaseSourceBinance: {
    en: 'Binance',
    de: 'Binance'
  },
  purchaseSourceKraken: {
    en: 'Kraken',
    de: 'Kraken'
  },
  purchaseSourceCoinbase: {
    en: 'Coinbase',
    de: 'Coinbase'
  },
  purchaseSourceKucoin: {
    en: 'KuCoin',
    de: 'KuCoin'
  },
  purchaseSourceOkx: {
    en: 'OKX',
    de: 'OKX'
  },
  purchaseSourceBybit: {
    en: 'Bybit',
    de: 'Bybit'
  },
  purchaseSourceDex: {
    en: 'DEX / THORChain',
    de: 'DEX / THORChain'
  },
  purchaseSourceCsv: {
    en: 'CSV import',
    de: 'CSV-Import'
  },
  purchaseSourceOther: {
    en: 'Other',
    de: 'Sonstiges'
  },
  dexSuggestionsTitle: {
    en: 'Auto-detected buy suggestions',
    de: 'Automatisch erkannte Kauf-Vorschläge'
  },
  searchDexBuys: {
    en: 'Search wallet history',
    de: 'Wallet-Verlauf durchsuchen'
  },
  searching: {
    en: 'Searching…',
    de: 'Suche…'
  },
  noWalletsForSuggestions: {
    en: 'Add a wallet address first to search its history.',
    de: 'Füge zuerst eine Wallet-Adresse hinzu, um deren Verlauf zu durchsuchen.'
  },
  noNewSwapsFound: {
    en: 'No new purchases found for your tracked wallets.',
    de: 'Keine neuen Käufe für deine getrackten Wallets gefunden.'
  },
  suggestionsFetchFailed: {
    en: 'Could not load wallet history right now, please try again later.',
    de: 'Wallet-Verlauf konnte gerade nicht geladen werden, bitte später erneut versuchen.'
  },
  acceptSuggestion: {
    en: 'Add to purchases',
    de: 'Als Kauf übernehmen'
  },
  dismissSuggestion: {
    en: 'Dismiss',
    de: 'Ignorieren'
  },
  addSearchAddress: {
    en: 'Add address to search',
    de: 'Adresse zur Suche hinzufügen'
  },
  extraSearchAddressHint: {
    en: 'Add any additional address (any chain) that might have been used for a swap — e.g. a sending address on another chain.',
    de: 'Füge eine zusätzliche Adresse hinzu (beliebige Chain), über die ein Swap gelaufen sein könnte — z. B. eine Absende-Adresse auf einer anderen Chain.'
  },
  includeTransfersLabel: {
    en: 'Also include plain wallet arrivals (e.g. CEX withdrawals)',
    de: 'Auch reine Wallet-Eingänge einbeziehen (z. B. CEX-Auszahlungen)'
  },
  includeTransfersHint: {
    en: 'These are RUNE amounts that simply arrived in your wallet (not an on-chain swap) — typically a withdrawal from an exchange. The exact price you paid there can\u2019t be reconstructed; the price shown is the market price at the moment the RUNE landed on-chain, so it\u2019s an estimate. Please check for transfers between your own wallets before accepting.',
    de: 'Das sind RUNE-Beträge, die einfach in deiner Wallet ankamen (kein On-Chain-Swap) — typischerweise eine Auszahlung von einer Börse. Der dort tatsächlich gezahlte Preis lässt sich nicht rekonstruieren; angezeigt wird der Marktpreis zum Zeitpunkt der Ankunft, also eine Schätzung. Bitte vor dem Übernehmen auf Transfers zwischen eigenen Wallets prüfen.'
  },
  estimatedBadge: {
    en: '≈ est.',
    de: '≈ gesch.'
  },
  estimatedPriceTooltip: {
    en: 'Estimated: market price at the time RUNE arrived in your wallet, not necessarily the price you actually paid.',
    de: 'Geschätzt: Marktpreis zum Zeitpunkt der Ankunft in deiner Wallet, nicht zwingend der tatsächlich gezahlte Preis.'
  },
  transferSourceLabel: {
    en: 'Wallet arrival',
    de: 'Wallet-Eingang'
  },
  exactSuggestionsTitle: {
    en: 'Exact — on-chain swaps',
    de: 'Genau — On-Chain-Swaps'
  },
  exactSuggestionsHint: {
    en: 'Real swap events. Amounts are exact; price is the market rate at the swap.',
    de: 'Echte Swap-Ereignisse. Mengen sind exakt; Preis ist der Marktkurs zum Swap-Zeitpunkt.'
  },
  searchExactBuys: {
    en: 'Search swaps',
    de: 'Nach Swaps suchen'
  },
  approxSuggestionsTitle: {
    en: 'Approximate — wallet arrivals',
    de: 'Ungefähr — Wallet-Eingänge'
  },
  approxSuggestionsHint: {
    en: 'Plain incoming transfers (e.g. CEX withdrawals). Price is only an estimate — check for self-transfers before accepting.',
    de: 'Reine Eingänge (z. B. CEX-Auszahlungen). Preis ist nur eine Schätzung — vor dem Übernehmen auf Eigen-Transfers prüfen.'
  },
  searchApproxBuys: {
    en: 'Search wallet arrivals',
    de: 'Nach Wallet-Eingängen suchen'
  },
  noNewTransfersFound: {
    en: 'No new wallet arrivals found for your tracked wallets.',
    de: 'Keine neuen Wallet-Eingänge für deine getrackten Wallets gefunden.'
  },
  importedFiles: {
    en: 'Imported files',
    de: 'Importierte Dateien'
  },
  dexBuysBatchLabel: {
    en: 'DEX buys (auto-detected)',
    de: 'DEX-Käufe (automatisch erkannt)'
  },
  deleteImport: {
    en: 'Delete this import',
    de: 'Diesen Import löschen'
  },
  confirmDeleteImport: {
    en: 'Delete all {n} entries from this import?',
    de: '{n} Einträge aus diesem Import löschen?'
  },
  confirmDeleteButton: {
    en: 'Delete',
    de: 'Löschen'
  },
  syncStatusSyncing: {
    en: 'syncing…',
    de: 'synchronisiere…'
  },
  syncStatusSynced: {
    en: 'synced',
    de: 'synchronisiert'
  },
  syncStatusError: {
    en: 'sync failed',
    de: 'Sync fehlgeschlagen'
  },
  syncOkHint: {
    en: 'Your purchase list is synced to this wallet address and available on any device.',
    de: 'Deine Kaufliste ist mit dieser Wallet-Adresse synchronisiert und auf jedem Gerät verfügbar.'
  },
  syncErrorHint: {
    en: 'Could not sync right now — your data is still saved locally.',
    de: 'Sync gerade nicht möglich — deine Daten sind trotzdem lokal gespeichert.'
  },
  syncServerCount: {
    en: 'Server has {n} entries',
    de: 'Server hat {n} Einträge'
  },
  cleanupDuplicates: {
    en: 'Clean up duplicates',
    de: 'Duplikate bereinigen'
  },
  duplicatesRemoved: {
    en: '{n} duplicate(s) removed',
    de: '{n} Duplikat(e) entfernt'
  },
  noDuplicatesFound: {
    en: 'No duplicates found',
    de: 'Keine Duplikate gefunden'
  },
  selectedCount: {
    en: '{n} selected',
    de: '{n} ausgewählt'
  },
  selectAll: {
    en: 'Select all',
    de: 'Alle auswählen'
  },
  deselectAll: {
    en: 'Deselect all',
    de: 'Auswahl aufheben'
  },
  deleteSelected: {
    en: 'Delete selected',
    de: 'Auswahl löschen'
  },
  confirmDeleteSelected: {
    en: 'Delete these {n} entries?',
    de: 'Diese {n} Einträge löschen?'
  }
};
const t = (key, lang) => TR[key] && (TR[key][lang] || TR[key].en) || key;
const fmtRune = (n, lang) => n == null ? '—' : n.toLocaleString(localeFor(lang), {
  maximumFractionDigits: 2
});
const fmtDate = (ts, lang) => new Date(ts).toLocaleDateString(localeFor(lang), {
  day: '2-digit',
  month: 'short'
});

// Für mehrjährige Zeiträume (z.B. 3-Jahres-Chart) reicht Tag+Monat allein nicht -- ohne
// Jahresangabe wäre z.B. "15. Jan" über 3 Jahre hinweg mehrdeutig.
const fmtDateWithYear = (ts, lang) => new Date(ts).toLocaleDateString(localeFor(lang), {
  day: '2-digit',
  month: 'short',
  year: '2-digit'
});

// Für Intraday-/Live-Charts (z.B. der 4H-Live-Chart im Sekundentakt) reicht ein Datum nicht --
// dort ist die Uhrzeit relevant.
const fmtTime = (ts, lang) => new Date(ts).toLocaleTimeString(localeFor(lang), {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

// Für x-Achsen-Beschriftungen im Daily-/1-Tages-Preis-Chart: Uhrzeit ohne Sekunden (die wären
// auf der Achse nur unnötiges Rauschen, anders als beim Live-Ticker, wo fmtTime sekundengenau
// mitzählt).
const fmtHourMin = (ts, lang) => new Date(ts).toLocaleTimeString(localeFor(lang), {
  hour: '2-digit',
  minute: '2-digit'
});

// Restzeit bis zu einem Zeitpunkt als "Xd Yh" / "Xh Ym" formatieren (z.B. Churn-Countdown).
const TIME_UNIT_LABELS = {
  de: {
    d: 'T',
    h: 'Std',
    m: 'Min',
    now: 'jeden Moment'
  },
  en: {
    d: 'd',
    h: 'h',
    m: 'm',
    now: 'any moment'
  },
  es: {
    d: 'd',
    h: 'h',
    m: 'm',
    now: 'en cualquier momento'
  },
  fr: {
    d: 'j',
    h: 'h',
    m: 'min',
    now: "d'un moment à l'autre"
  },
  it: {
    d: 'g',
    h: 'h',
    m: 'min',
    now: 'da un momento all\'altro'
  },
  pt: {
    d: 'd',
    h: 'h',
    m: 'min',
    now: 'a qualquer momento'
  },
  ja: {
    d: '日',
    h: '時間',
    m: '分',
    now: 'まもなく'
  },
  zh: {
    d: '天',
    h: '小时',
    m: '分钟',
    now: '随时'
  },
  ru: {
    d: 'д',
    h: 'ч',
    m: 'мин',
    now: 'с минуты на минуту'
  },
  ko: {
    d: '일',
    h: '시간',
    m: '분',
    now: '곧'
  }
};
const fmtCountdown = (targetMs, lang) => {
  const u = TIME_UNIT_LABELS[lang] || TIME_UNIT_LABELS.en;
  const ms = targetMs - Date.now();
  if (ms <= 0) return u.now;
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor(totalMinutes % (60 * 24) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}${u.d} ${hours}${u.h}`;
  if (hours > 0) return `${hours}${u.h} ${minutes}${u.m}`;
  return `${minutes}${u.m}`;
};

// Für die APY-Anzeige: 0.298 -> "29.8%" (bzw. lokalisiertes Dezimaltrennzeichen).
const fmtApyPercent = (apy, lang) => apy == null ? '—' : `${(apy * 100).toLocaleString(localeFor(lang), {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1
})}%`;

// ----------------------------------------------------------------------------------------------
// Live-APY für den GERADE LAUFENDEN Churn -- 1:1 aus boonetools (src/lib/bond-tracker/apy.js)
// übernommen, statt (wie zuvor) auf den Abschluss des Churns zu warten. Kernidee: reward/principal
// wird NICHT einfach durch die bisher verstrichene Zeit geteilt (das würde am Anfang eines Churns
// zu wilden, sich schnell ändernden Werten führen, weil eine winzige verstrichene Zeit im Nenner
// steht) -- stattdessen wird die NOMINELLE Churn-Periode als Nenner verwendet, solange der Churn
// noch "on schedule" ist. Der Wert wandert so während des Churns langsam auf den tatsächlichen
// Endwert zu, statt zu Beginn zu explodieren. Ist ein Churn dagegen überfällig (progressedBlocks >
// totalBlocks -- z.B. weil Churning netzwerkweit pausiert ist), wird auf die tatsächlich
// verstrichene Zeit umgeschaltet ("isProlonged"), damit die Anzeige während einer längeren Pause
// nicht künstlich hoch eingefroren bleibt.
const MIN_CHURN_PROGRESS_RATIO = 0.05;
function calculateAPR(reward, principal, timePeriodSeconds) {
  if (!reward || !principal || principal === 0 || !timePeriodSeconds || timePeriodSeconds === 0) return 0;
  const timePeriodYears = timePeriodSeconds / (365 * 24 * 3600);
  const rateForPeriod = reward / principal;
  return rateForPeriod / timePeriodYears;
}
function calculateAPY(apr, compoundingPeriods = 365) {
  if (!apr) return 0;
  return Math.pow(1 + apr / compoundingPeriods, compoundingPeriods) - 1;
}
function getEffectiveChurnPeriodSeconds({
  lastChurnTimestamp,
  churnIntervalSeconds,
  now = Date.now() / 1000
}) {
  const normalizedNow = Number.isFinite(now) ? now : Date.now() / 1000;
  const normalizedLastChurn = Number.isFinite(lastChurnTimestamp) ? lastChurnTimestamp : 0;
  const elapsedSeconds = Math.max(0, normalizedNow - normalizedLastChurn);
  const normalizedIntervalSeconds = Math.max(0, Number.isFinite(churnIntervalSeconds) ? churnIntervalSeconds : 0);
  return normalizedIntervalSeconds > 0 ? Math.max(elapsedSeconds, normalizedIntervalSeconds) : elapsedSeconds;
}
function getEffectiveChurnProgress({
  progressedBlocks,
  totalBlocks,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO
}) {
  const normalizedTotalBlocks = Math.max(0, Number(totalBlocks) || 0);
  const normalizedProgressedBlocks = Math.max(0, Number(progressedBlocks) || 0);
  const progressRatio = normalizedTotalBlocks > 0 ? normalizedProgressedBlocks / normalizedTotalBlocks : 0;
  const normalizedMinProgressRatio = Math.max(0, Math.min(1, Number.isFinite(minProgressRatio) ? minProgressRatio : MIN_CHURN_PROGRESS_RATIO));
  return {
    progressRatio,
    effectiveProgressRatio: progressRatio > 0 ? Math.max(progressRatio, normalizedMinProgressRatio) : 0
  };
}
function estimateCurrentChurnYields({
  reward,
  principal,
  progressedBlocks,
  totalBlocks,
  secondsPerBlock,
  minProgressRatio = MIN_CHURN_PROGRESS_RATIO,
  lastChurnTimestamp,
  churnIntervalSeconds,
  now = Date.now() / 1000,
  compoundingPeriods = 365
}) {
  const normalizedReward = Number(reward) || 0;
  const progress = getEffectiveChurnProgress({
    progressedBlocks,
    totalBlocks,
    minProgressRatio
  });
  const normalizedTotalBlocks = Math.max(0, Number(totalBlocks) || 0);
  const normalizedProgressedBlocks = Math.max(0, Number(progressedBlocks) || 0);
  const normalizedSecondsPerBlock = Math.max(0, Number(secondsPerBlock) || 0);
  const blockPeriodSeconds = normalizedTotalBlocks > 0 && normalizedSecondsPerBlock > 0 ? normalizedTotalBlocks * normalizedSecondsPerBlock : 0;
  const elapsedBlockPeriodSeconds = normalizedProgressedBlocks > 0 && normalizedSecondsPerBlock > 0 ? normalizedProgressedBlocks * normalizedSecondsPerBlock : 0;
  if ((blockPeriodSeconds > 0 || elapsedBlockPeriodSeconds > 0) && normalizedReward > 0) {
    const effectivePeriodSeconds = Math.max(blockPeriodSeconds, elapsedBlockPeriodSeconds);
    const apr = calculateAPR(normalizedReward, principal, effectivePeriodSeconds);
    const apy = calculateAPY(apr, compoundingPeriods);
    return {
      apr,
      apy,
      progressRatio: progress.progressRatio,
      effectiveProgressRatio: progress.effectiveProgressRatio,
      effectivePeriodSeconds,
      isProlonged: elapsedBlockPeriodSeconds > blockPeriodSeconds
    };
  }
  const effectivePeriodSeconds = getEffectiveChurnPeriodSeconds({
    lastChurnTimestamp,
    churnIntervalSeconds,
    now
  });
  const apr = calculateAPR(normalizedReward, principal, effectivePeriodSeconds);
  const apy = calculateAPY(apr, compoundingPeriods);
  return {
    apr,
    apy,
    progressRatio: progress.progressRatio,
    effectiveProgressRatio: progress.effectiveProgressRatio,
    effectivePeriodSeconds,
    isProlonged: false
  };
}
// ----------------------------------------------------------------------------------------------

// --- Icons (inline SVG, no external deps) ---
const IconSearch = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 16,
  height: p.size || 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "8"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "21",
  x2: "16.65",
  y2: "16.65"
}));
const IconLoader = p => /*#__PURE__*/React.createElement("svg", {
  className: "tp-spin",
  width: p.size || 16,
  height: p.size || 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round"
}, /*#__PURE__*/React.createElement("line", {
  x1: "12",
  y1: "2",
  x2: "12",
  y2: "6"
}), /*#__PURE__*/React.createElement("line", {
  x1: "12",
  y1: "18",
  x2: "12",
  y2: "22"
}), /*#__PURE__*/React.createElement("line", {
  x1: "4.93",
  y1: "4.93",
  x2: "7.76",
  y2: "7.76"
}), /*#__PURE__*/React.createElement("line", {
  x1: "16.24",
  y1: "16.24",
  x2: "19.07",
  y2: "19.07"
}), /*#__PURE__*/React.createElement("line", {
  x1: "2",
  y1: "12",
  x2: "6",
  y2: "12"
}), /*#__PURE__*/React.createElement("line", {
  x1: "18",
  y1: "12",
  x2: "22",
  y2: "12"
}), /*#__PURE__*/React.createElement("line", {
  x1: "4.93",
  y1: "19.07",
  x2: "7.76",
  y2: "16.24"
}), /*#__PURE__*/React.createElement("line", {
  x1: "16.24",
  y1: "7.76",
  x2: "19.07",
  y2: "4.93"
}));
const IconAlert = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 16,
  height: p.size || 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "10"
}), /*#__PURE__*/React.createElement("line", {
  x1: "12",
  y1: "8",
  x2: "12",
  y2: "12"
}), /*#__PURE__*/React.createElement("line", {
  x1: "12",
  y1: "16",
  x2: "12.01",
  y2: "16"
}));
const IconUp = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "23 6 13.5 15.5 8.5 10.5 1 18"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "17 6 23 6 23 12"
}));
const IconDown = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "23 18 13.5 8.5 8.5 13.5 1 6"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "17 18 23 18 23 12"
}));
const IconWaves = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 17,
  height: p.size || 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.5 0 2.5 2 5 2 2.4 0 2.5-1.8 4.5-2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.5 0 2.5 2 5 2 2.4 0 2.5-1.8 4.5-2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.5 0 2.5 2 5 2 2.4 0 2.5-1.8 4.5-2"
}));
// Lotusblüte, Proportionen aus Referenzbild vermessen (Winkel 0/±38/±75°,
// Längenverhältnis 1 : 0.94 : 0.82), plus RUNE-"R" als Stempel.
// Neues Logo: Auge (dünner Umriss) mit klarem, spitz gezeichnetem Blitz als Pupille —
// feinere Linienstärke, sauberere Zickzack-Form für mehr Qualität/Schärfe.
const IconBoltLogo = p => {
  const size = p.size || 24;
  const color = p.color || '#00DEE1';
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 100 100",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    style: {
      display: 'block',
      flexShrink: 0,
      ...(p.style || {})
    }
  }, /*#__PURE__*/React.createElement("path", {
    d: "M6,50 Q50,10 94,50 Q50,90 6,50 Z",
    fill: "none",
    stroke: color,
    strokeWidth: p.strokeWidth || 4.2,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }), /*#__PURE__*/React.createElement("path", {
    fill: color,
    d: "M56.27,31.5 L39.48,53.24 L48.33,53.94 L44.84,68.43 L60.45,49.13 L51.46,48.64 Z"
  }));
};
const IconLotus = p => {
  const size = p.size || 17;
  const baseX = 12,
    baseY = 16.58;
  const sw = 0.6;
  const bez = (p0, c1, c2, p1) => `M${p0[0]},${p0[1]} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p1[0]},${p1[1]}`;
  const rot = (x, y, deg) => {
    const a = deg * Math.PI / 180;
    return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  };
  const petal = (angleDeg, length, width, key) => {
    const P = (lx, ly) => {
      const [rx, ry] = rot(lx, ly, angleDeg);
      return [baseX + rx, baseY + ry];
    };
    const p0 = P(0, 0);
    const tip = P(0, -length);
    const c1L = P(-width * 0.55, -length * 0.30);
    const c2L = P(-width * 0.32, -length * 0.76);
    const c1R = P(width * 0.32, -length * 0.76);
    const c2R = P(width * 0.55, -length * 0.30);
    const vein0 = P(0, -length * 0.10);
    const vein1 = P(0, -length * 0.86);
    return /*#__PURE__*/React.createElement("g", {
      key: key
    }, /*#__PURE__*/React.createElement("path", {
      d: bez(p0, c1L, c2L, tip),
      fill: "none"
    }), /*#__PURE__*/React.createElement("path", {
      d: bez(tip, c2R, c1R, p0),
      fill: "none"
    }), /*#__PURE__*/React.createElement("line", {
      x1: vein0[0],
      y1: vein0[1],
      x2: vein1[0],
      y2: vein1[1],
      strokeWidth: sw * 0.55
    }));
  };
  const L = 13.99;
  const petals = [[0, L * 1.00, L * 1.00 * 0.30], [-38, L * 0.94, L * 0.94 * 0.36], [38, L * 0.94, L * 0.94 * 0.36], [-75, L * 0.82, L * 0.82 * 0.44], [75, L * 0.82, L * 0.82 * 0.44]];

  // RUNE-"R" als Stempel (statt Spirale) — Originalpfad viewBox 0 0 109 214.
  const rTargetH = 3.56;
  const rScale = rTargetH / 214;
  const rMidX = (13 + 96) / 2,
    rMidY = 214 / 2;
  const rCx = baseX,
    rCy = baseY + 3.04;
  const rMap = (x, y) => [rCx + (x - rMidX) * rScale, rCy + (y - rMidY) * rScale];
  const [rx1, ry1] = rMap(13, 0);
  const [rx2, ry2] = rMap(13, 214);
  const [dx1, dy1] = rMap(13, 0);
  const [dx2, dy2] = rMap(82, 58);
  const [dx3, dy3] = rMap(59, 112);
  const [dx4, dy4] = rMap(96, 214);
  const rStrokeW = Math.max(0.45, 27 * rScale);
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }, petals.map(([a, l, w], i) => petal(a, l, w, i)), /*#__PURE__*/React.createElement("path", {
    d: `M${rx1},${ry1} L${rx2},${ry2} M${dx1},${dy1} L${dx2},${dy2} L${dx3},${dy3} L${dx4},${dy4}`,
    strokeWidth: rStrokeW
  }));
};
const IconPointer = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M3 3l7.07 16.97 2.51-7.39 7.39-2.51z"
}));
const IconHLine = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round"
}, /*#__PURE__*/React.createElement("line", {
  x1: "3",
  y1: "12",
  x2: "21",
  y2: "12"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "3",
  cy: "12",
  r: "1.6",
  fill: "currentColor",
  stroke: "none"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "21",
  cy: "12",
  r: "1.6",
  fill: "currentColor",
  stroke: "none"
}));
const IconPencil = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"
}), /*#__PURE__*/React.createElement("path", {
  d: "M15 5l4 4"
}));
const IconTrendLine = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round"
}, /*#__PURE__*/React.createElement("line", {
  x1: "4",
  y1: "20",
  x2: "20",
  y2: "4"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "4",
  cy: "20",
  r: "1.6",
  fill: "currentColor",
  stroke: "none"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "20",
  cy: "4",
  r: "1.6",
  fill: "currentColor",
  stroke: "none"
}));
const IconTrash = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "3 6 5 6 21 6"
}), /*#__PURE__*/React.createElement("path", {
  d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
}), /*#__PURE__*/React.createElement("path", {
  d: "M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"
}));
const IconUndo = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "9 14 4 9 9 4"
}), /*#__PURE__*/React.createElement("path", {
  d: "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"
}));
const IconZoomReset = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "21",
  x2: "16.65",
  y2: "16.65"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8.5",
  y1: "11",
  x2: "13.5",
  y2: "11"
}));
const IconZoomIn = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "21",
  x2: "16.65",
  y2: "16.65"
}), /*#__PURE__*/React.createElement("line", {
  x1: "11",
  y1: "8",
  x2: "11",
  y2: "14"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8",
  y1: "11",
  x2: "14",
  y2: "11"
}));
const IconZoomOut = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "7"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "21",
  x2: "16.65",
  y2: "16.65"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8",
  y1: "11",
  x2: "14",
  y2: "11"
}));
const IconExpand = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 12,
  height: p.size || 12,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "15 3 21 3 21 9"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "9 21 3 21 3 15"
}), /*#__PURE__*/React.createElement("line", {
  x1: "21",
  y1: "3",
  x2: "14",
  y2: "10"
}), /*#__PURE__*/React.createElement("line", {
  x1: "3",
  y1: "21",
  x2: "10",
  y2: "14"
}));
const IconRefresh = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "23 4 23 10 17 10"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "1 20 1 14 7 14"
}), /*#__PURE__*/React.createElement("path", {
  d: "M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"
}));
const IconDownload = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "7 10 12 15 17 10"
}), /*#__PURE__*/React.createElement("line", {
  x1: "12",
  y1: "15",
  x2: "12",
  y2: "3"
}));
const IconFileText = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
}), /*#__PURE__*/React.createElement("polyline", {
  points: "14 2 14 8 20 8"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8",
  y1: "13",
  x2: "16",
  y2: "13"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8",
  y1: "17",
  x2: "16",
  y2: "17"
}), /*#__PURE__*/React.createElement("line", {
  x1: "8",
  y1: "9",
  x2: "10",
  y2: "9"
}));
const IconEye = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "12",
  cy: "12",
  r: "3"
}));
const IconEyeOff = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a18.87 18.87 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
}), /*#__PURE__*/React.createElement("line", {
  x1: "1",
  y1: "1",
  x2: "23",
  y2: "23"
}));
const IconCopy = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("rect", {
  x: "9",
  y: "9",
  width: "12",
  height: "12",
  rx: "2"
}), /*#__PURE__*/React.createElement("path", {
  d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
}));

const IconCheck = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 14,
  height: p.size || 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.4",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M20 6 9 17l-5-5"
}));

const IconWallet = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 16,
  height: p.size || 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M21 12V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"
}), /*#__PURE__*/React.createElement("path", {
  d: "M16 12h4a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-4a2 2 0 0 1 0-4z"
}));

// Einfache, klar erkennbare Glyphen (keine exakten Marken-Logos) für die Coins, die THORChain
// als native Gas-Assets unterstützt — im gleichen kräftigen Strich-Stil wie RUNE/BTC, damit sie
// bei kleiner Größe neben dem RUNE-Preis nicht "verschwinden".
const IconCoinGlyph = p => {
  const size = p.size || 17;
  const sw = 2.6;
  const inner = (() => {
    switch (p.symbol) {
      case 'BTC':
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M8 4.5v15"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M7.5 6.2h6.7a3 3 0 0 1 0 6H7.5"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M7.5 12.2h7.2a3 3 0 0 1 0 6H7.5"
        })), /*#__PURE__*/React.createElement("g", {
          stroke: "currentColor",
          strokeWidth: sw * 0.85,
          strokeLinecap: "round"
        }, /*#__PURE__*/React.createElement("line", {
          x1: "10.6",
          y1: "3",
          x2: "10.6",
          y2: "5.4"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "10.6",
          y1: "18.6",
          x2: "10.6",
          y2: "21"
        })));
      case 'ETH':
        // Diamant/Raute, angelehnt an Ethereums Form
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw,
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M12 2.5 L18.5 12.5 L12 16 L5.5 12.5 Z"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M5.5 13.8 L12 21.5 L18.5 13.8 L12 17.7 Z"
        }));
      case 'BNB':
        // vier kleine Rauten im Kreuz, wie BNBs Logo
        return /*#__PURE__*/React.createElement("g", {
          fill: "currentColor"
        }, /*#__PURE__*/React.createElement("rect", {
          x: "10.5",
          y: "2",
          width: "3",
          height: "3",
          transform: "rotate(45 12 3.5)"
        }), /*#__PURE__*/React.createElement("rect", {
          x: "10.5",
          y: "19",
          width: "3",
          height: "3",
          transform: "rotate(45 12 20.5)"
        }), /*#__PURE__*/React.createElement("rect", {
          x: "2",
          y: "10.5",
          width: "3",
          height: "3",
          transform: "rotate(45 3.5 12)"
        }), /*#__PURE__*/React.createElement("rect", {
          x: "19",
          y: "10.5",
          width: "3",
          height: "3",
          transform: "rotate(45 20.5 12)"
        }), /*#__PURE__*/React.createElement("rect", {
          x: "10.5",
          y: "10.5",
          width: "3",
          height: "3",
          transform: "rotate(45 12 12)"
        }));
      case 'XRP':
        // gefüllte Sanduhr-/Schleifenform, angelehnt an XRPs Markenzeichen
        return /*#__PURE__*/React.createElement("g", {
          fill: "currentColor"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M4 4.2c3.6 2.6 5.6 4.6 8 7.8 2.4-3.2 4.4-5.2 8-7.8l1.2 1.6c-3.4 2.5-5.3 4.4-7.5 7.2h-3.4c-2.2-2.8-4.1-4.7-7.5-7.2z"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M4 19.8c3.6-2.6 5.6-4.6 8-7.8 2.4 3.2 4.4 5.2 8 7.8l1.2-1.6c-3.4-2.5-5.3-4.4-7.5-7.2h-3.4c-2.2 2.8-4.1 4.7-7.5 7.2z"
        }));
      case 'SOL':
        // drei parallele, versetzte Balken (Solana-Motiv)
        return /*#__PURE__*/React.createElement("g", {
          fill: "currentColor"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M4.5 6.5h14l-2.3 2.4h-14z"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M4.5 15.1h14l-2.3 2.4h-14z"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M6.8 10.8h14l-2.3 2.4h-14z"
        }));
      case 'TRX':
        // T-förmiges Segelsymbol
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M4 5h16"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M12 5v15"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M12 5 L19 9 L12 12Z",
          fill: "currentColor",
          stroke: "none"
        }));
      case 'DOGE':
        // Ð mit Querstrich, angelehnt an Dogecoins Symbol
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M8 4.5v15"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M8 5h3.5a7 7 0 0 1 0 14H8"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "4.5",
          y1: "10",
          x2: "8",
          y2: "10"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "4.5",
          y1: "14",
          x2: "8",
          y2: "14"
        }));
      case 'BCH':
        // Gefülltes ₿-ähnliches Symbol (Bitcoin-Cash-Optik, eigene Akzentfarbe)
        return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M8 4.5v15"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M7.5 6.2h6a3 3 0 0 1 0 6h-6"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M7.5 12.2h6.5a3 3 0 0 1 0 6h-6.5"
        })), /*#__PURE__*/React.createElement("g", {
          stroke: "currentColor",
          strokeWidth: sw * 0.85,
          strokeLinecap: "round"
        }, /*#__PURE__*/React.createElement("line", {
          x1: "11.5",
          y1: "2.6",
          x2: "10.3",
          y2: "5.2"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "11.7",
          y1: "18.8",
          x2: "10.5",
          y2: "21.4"
        })));
      case 'LTC':
        // Gefülltes Ł (Litecoin-Wortmarke)
        return /*#__PURE__*/React.createElement("g", {
          fill: "currentColor"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M8.3 3.8h3.4l-2.1 8h2.9l-.6 2.1h-2.9l-1 3.6h9v2.5H4.5l1.6-5.7H3.9l.6-2.1h2.2z"
        }));
      case 'AVAX':
        // Berg-/Dreieck-Silhouette
        return /*#__PURE__*/React.createElement("g", {
          fill: "currentColor"
        }, /*#__PURE__*/React.createElement("path", {
          d: "M12 3 L20 19 H4 Z"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M9.3 19 L12.7 12.5 L16 19 H13.2 L12.7 18 L12.2 19 Z",
          fill: "#0A0A0A"
        }));
      case 'ATOM':
        // Atomkern mit zwei sich kreuzenden Umlaufbahnen
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw * 0.75
        }, /*#__PURE__*/React.createElement("circle", {
          cx: "12",
          cy: "12",
          r: "2.3",
          fill: "currentColor",
          stroke: "none"
        }), /*#__PURE__*/React.createElement("ellipse", {
          cx: "12",
          cy: "12",
          rx: "9.5",
          ry: "4"
        }), /*#__PURE__*/React.createElement("ellipse", {
          cx: "12",
          cy: "12",
          rx: "9.5",
          ry: "4",
          transform: "rotate(60 12 12)"
        }), /*#__PURE__*/React.createElement("ellipse", {
          cx: "12",
          cy: "12",
          rx: "9.5",
          ry: "4",
          transform: "rotate(120 12 12)"
        }));
      case 'TCY':
        // Kein etabliertes Markenzeichen -- Kreis mit "T"-Monogramm, im gleichen kräftigen Strich-Stil
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw * 0.8,
          strokeLinecap: "round"
        }, /*#__PURE__*/React.createElement("circle", {
          cx: "12",
          cy: "12",
          r: "9.2"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "7.8",
          y1: "8.2",
          x2: "16.2",
          y2: "8.2"
        }), /*#__PURE__*/React.createElement("line", {
          x1: "12",
          y1: "8.2",
          x2: "12",
          y2: "16.4"
        }));
      case 'RUJI':
        // Kein etabliertes Markenzeichen -- Kreis mit "R"-Monogramm, im gleichen kräftigen Strich-Stil
        return /*#__PURE__*/React.createElement("g", {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: sw * 0.8,
          strokeLinecap: "round",
          strokeLinejoin: "round"
        }, /*#__PURE__*/React.createElement("circle", {
          cx: "12",
          cy: "12",
          r: "9.2"
        }), /*#__PURE__*/React.createElement("path", {
          d: "M9,8 L9,16 M9,8 L13.2,8 A2.4,2.4 0 0 1 13.2,12.8 L9,12.8 M11.8,12.8 L14.5,16"
        }));
      default:
        return null;
    }
  })();
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    xmlns: "http://www.w3.org/2000/svg"
  }, inner);
};

// Breite Auswahl an Fiat-Währungen, die CoinGecko direkt unterstützt (vs_currencies) — deckt
// die allermeisten Nutzer weltweit ab. USD/EUR laufen zusätzlich über Binance (schneller,
// großzügigeres Rate-Limit); alle anderen über CoinGecko.
const CURRENCY_OPTIONS = [{
  code: 'usd',
  symbol: '$',
  label: 'US-Dollar'
}, {
  code: 'eur',
  symbol: '€',
  label: 'Euro'
}, {
  code: 'gbp',
  symbol: '£',
  label: 'Britisches Pfund'
}, {
  code: 'jpy',
  symbol: '¥',
  label: 'Japanischer Yen'
}, {
  code: 'chf',
  symbol: 'CHF',
  label: 'Schweizer Franken'
}, {
  code: 'cad',
  symbol: 'CA$',
  label: 'Kanadischer Dollar'
}, {
  code: 'aud',
  symbol: 'A$',
  label: 'Australischer Dollar'
}, {
  code: 'nzd',
  symbol: 'NZ$',
  label: 'Neuseeland-Dollar'
}, {
  code: 'cny',
  symbol: '¥',
  label: 'Chinesischer Yuan'
}, {
  code: 'hkd',
  symbol: 'HK$',
  label: 'Hongkong-Dollar'
}, {
  code: 'sgd',
  symbol: 'S$',
  label: 'Singapur-Dollar'
}, {
  code: 'inr',
  symbol: '₹',
  label: 'Indische Rupie'
}, {
  code: 'krw',
  symbol: '₩',
  label: 'Südkoreanischer Won'
}, {
  code: 'idr',
  symbol: 'Rp',
  label: 'Indonesische Rupiah'
}, {
  code: 'php',
  symbol: '₱',
  label: 'Philippinischer Peso'
}, {
  code: 'thb',
  symbol: '฿',
  label: 'Thailändischer Baht'
}, {
  code: 'vnd',
  symbol: '₫',
  label: 'Vietnamesischer Dong'
}, {
  code: 'brl',
  symbol: 'R$',
  label: 'Brasilianischer Real'
}, {
  code: 'mxn',
  symbol: 'MX$',
  label: 'Mexikanischer Peso'
}, {
  code: 'ars',
  symbol: 'AR$',
  label: 'Argentinischer Peso'
}, {
  code: 'try',
  symbol: '₺',
  label: 'Türkische Lira'
}, {
  code: 'zar',
  symbol: 'R',
  label: 'Südafrikanischer Rand'
}, {
  code: 'sek',
  symbol: 'kr',
  label: 'Schwedische Krone'
}, {
  code: 'nok',
  symbol: 'kr',
  label: 'Norwegische Krone'
}, {
  code: 'dkk',
  symbol: 'kr',
  label: 'Dänische Krone'
}, {
  code: 'pln',
  symbol: 'zł',
  label: 'Polnischer Zloty'
}, {
  code: 'aed',
  symbol: 'د.إ',
  label: 'VAE-Dirham'
}, {
  code: 'sar',
  symbol: '﷼',
  label: 'Saudi-Riyal'
}, {
  code: 'ils',
  symbol: '₪',
  label: 'Israelischer Schekel'
}, {
  code: 'rub',
  symbol: '₽',
  label: 'Russischer Rubel'
}];
const getCurrencySymbol = code => (CURRENCY_OPTIONS.find(c => c.code === code) || CURRENCY_OPTIONS[0]).symbol;

// Die von THORChain als native Gas-Assets unterstützten Coins (Stand 2026) — jeweils mit
// Binance-Symbol (primäre, großzügig rate-limitierte Preisquelle) und CoinGecko-ID (Fallback).
const ALT_COIN_OPTIONS = [{
  code: 'BTC',
  label: 'Bitcoin',
  binanceSymbol: 'BTCUSDT',
  geckoId: 'bitcoin',
  color: '#F7931A',
  glyph: 'BTC'
}, {
  code: 'ETH',
  label: 'Ethereum',
  binanceSymbol: 'ETHUSDT',
  geckoId: 'ethereum',
  color: '#627EEA',
  glyph: 'ETH'
}, {
  code: 'BNB',
  label: 'BNB',
  binanceSymbol: 'BNBUSDT',
  geckoId: 'binancecoin',
  color: '#F3BA2F',
  glyph: 'BNB'
}, {
  code: 'XRP',
  label: 'XRP',
  binanceSymbol: 'XRPUSDT',
  geckoId: 'ripple',
  color: '#25A768',
  glyph: 'XRP'
}, {
  code: 'SOL',
  label: 'Solana',
  binanceSymbol: 'SOLUSDT',
  geckoId: 'solana',
  color: '#9945FF',
  glyph: 'SOL'
}, {
  code: 'TRX',
  label: 'TRON',
  binanceSymbol: 'TRXUSDT',
  geckoId: 'tron',
  color: '#EF0027',
  glyph: 'TRX'
}, {
  code: 'DOGE',
  label: 'Dogecoin',
  binanceSymbol: 'DOGEUSDT',
  geckoId: 'dogecoin',
  color: '#C2A633',
  glyph: 'DOGE'
}, {
  code: 'BCH',
  label: 'Bitcoin Cash',
  binanceSymbol: 'BCHUSDT',
  geckoId: 'bitcoin-cash',
  color: '#8DC351',
  glyph: 'BCH'
}, {
  code: 'LTC',
  label: 'Litecoin',
  binanceSymbol: 'LTCUSDT',
  geckoId: 'litecoin',
  color: '#345D9D',
  glyph: 'LTC'
}, {
  code: 'AVAX',
  label: 'Avalanche',
  binanceSymbol: 'AVAXUSDT',
  geckoId: 'avalanche-2',
  color: '#E84142',
  glyph: 'AVAX'
}, {
  code: 'ATOM',
  label: 'Cosmos',
  binanceSymbol: 'ATOMUSDT',
  geckoId: 'cosmos',
  color: '#2E3148',
  glyph: 'ATOM'
},
// TCY und RUJI sind (Stand jetzt) NICHT auf Binance gelistet -- binanceSymbol bleibt hier
// bewusst null. Das ist ein Signal für die Preis-/Chart-Logik weiter unten, für diese beiden
// Coins durchgehend auf CoinGecko auszuweichen, statt (wie bei den anderen Coins) primär
// Binance zu verwenden. Alle bestehenden Binance-Aufrufe fangen ein null/leeres Symbol
// ohnehin über ihren vorhandenen CoinGecko-Fallback ab; für den 1-Sekunden-Live-Ticker und
// den Vergleichs-Chart gibt es zusätzlich einen dedizierten CoinGecko-Pfad (siehe unten).
// TCY ist selbst ein natives THORChain-Asset -- der Preis kommt direkt aus dem RUNE/TCY-Pool
// via Midgard (poolAsset), keine externe Preis-API mehr nötig. geckoId bleibt als letzter
// Notfall-Fallback, falls Midgard mal komplett nicht erreichbar sein sollte. Zusätzlich wird
// TCY nicht wie die anderen Coins per normierter Preis-Performance verglichen (dafür würde
// ohnehin nur wenig Handelshistorie existieren), sondern über compareMode als Marketcap-
// Anteil ggü. RUNE dargestellt (siehe compareMode-Auswertung weiter unten im Component-Code).
{
  code: 'TCY',
  label: 'THORChain Yield',
  binanceSymbol: null,
  poolAsset: 'THOR.TCY',
  geckoId: 'tcy',
  color: '#F5A623',
  glyph: 'TCY',
  compareMode: 'marketcapPctOfRune'
}];

// Echte Coin-Logos direkt von CoinGecko (nicht aus einem veralteten Drittanbieter-Icon-Set —
// das alte Set hatte z.B. Solana nie richtig aufgenommen). Ein einziger Sammel-Request für
// alle unterstützten Coins, modulweit gecacht, damit jede Kachel/jeder Picker-Eintrag densel-
// ben Abruf wiederverwendet. Schlägt das Laden fehl (z.B. offline), fällt automatisch auf die
// handgezeichnete Glyphe zurück, damit nie ein leerer/kaputter Platzhalter zu sehen ist.
let coinImageCache = null; // { [geckoId]: imageUrl }
let coinImageCachePromise = null;
const loadCoinImages = () => {
  if (coinImageCache) return Promise.resolve(coinImageCache);
  if (coinImageCachePromise) return coinImageCachePromise;
  const ids = ['thorchain', ...ALT_COIN_OPTIONS.map(c => c.geckoId)].join(',');
  coinImageCachePromise = fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}`).then(res => res.ok ? res.json() : []).then(list => {
    const map = {};
    (list || []).forEach(c => {
      if (c && c.id && c.image) map[c.id] = c.image;
    });
    coinImageCache = map;
    return map;
  }).catch(() => {
    coinImageCache = {};
    return {};
  });
  return coinImageCachePromise;
};
const CoinLogo = ({
  code,
  geckoId,
  size = 15,
  glyph
}) => {
  const [imgUrl, setImgUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadCoinImages().then(map => {
      if (cancelled) return;
      if (map[geckoId]) setImgUrl(map[geckoId]);else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [geckoId]);
  if (failed || !imgUrl) {
    if (glyph === 'RUNE') {
      return /*#__PURE__*/React.createElement(IconRuneR, {
        size: size * 0.55,
        solid: "#0A0A0A"
      });
    }
    return /*#__PURE__*/React.createElement(IconCoinGlyph, {
      symbol: glyph,
      size: size
    });
  }
  return /*#__PURE__*/React.createElement("img", {
    src: imgUrl,
    width: size,
    height: size,
    style: {
      display: 'block',
      borderRadius: '50%'
    },
    onError: () => setFailed(true),
    alt: code
  });
};
const IconSwapArrows = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2.2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M4 8h13l-3.5-3.5"
}), /*#__PURE__*/React.createElement("path", {
  d: "M20 16H7l3.5 3.5"
}));
const IconX = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "currentColor"
}, /*#__PURE__*/React.createElement("path", {
  d: "M18.3 3h3.2l-7 8 8.2 10.9h-6.4l-5-6.6-5.8 6.6H1.3l7.5-8.6L1 3h6.6l4.6 6.1zM17.1 20h1.8L7 4.9H5.1z"
}));
const IconGithub = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "currentColor"
}, /*#__PURE__*/React.createElement("path", {
  d: "M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.11-3.2.7-3.87-1.36-3.87-1.36-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.7.08-.7 1.17.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.2-3.1-.12-.29-.52-1.46.11-3.05 0 0 .98-.31 3.2 1.19a11.1 11.1 0 0 1 5.83 0c2.22-1.5 3.2-1.19 3.2-1.19.63 1.59.23 2.76.11 3.05.75.81 1.2 1.84 1.2 3.1 0 4.43-2.69 5.41-5.26 5.7.41.36.78 1.07.78 2.16 0 1.56-.01 2.82-.01 3.2 0 .3.2.66.79.55A10.52 10.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"
}));
const IconServer = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("rect", {
  x: "3",
  y: "4",
  width: "18",
  height: "7",
  rx: "1.5"
}), /*#__PURE__*/React.createElement("rect", {
  x: "3",
  y: "13",
  width: "18",
  height: "7",
  rx: "1.5"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "7",
  cy: "7.5",
  r: "0.9",
  fill: "currentColor",
  stroke: "none"
}), /*#__PURE__*/React.createElement("circle", {
  cx: "7",
  cy: "16.5",
  r: "0.9",
  fill: "currentColor",
  stroke: "none"
}));
const IconActivity = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("polyline", {
  points: "22 12 18 12 15 21 9 3 6 12 2 12"
}));
const IconBell = p => /*#__PURE__*/React.createElement("svg", {
  width: p.size || 15,
  height: p.size || 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round"
}, /*#__PURE__*/React.createElement("path", {
  d: "M6 8a6 6 0 0 1 12 0c0 5.2 1.4 7.2 2.2 8.1a1 1 0 0 1-.8 1.6H4.6a1 1 0 0 1-.8-1.6C4.6 15.2 6 13.2 6 8Z"
}), /*#__PURE__*/React.createElement("path", {
  d: "M10 21a2 2 0 0 0 4 0"
}));

// Gemeinsamer Look für die oberen Übersichts-Kästchen (Portfolio-Wert, BTC-Preis, 24h-Volumen)
// Selber Cloudflare Worker wie für die Bond-Rewards-Historie (siehe REWARDS_BACKEND_BASE weiter
// unten in der Komponente) -- hier als modul-weite Konstante, damit sie schon beim useEffect für
// den Kauflisten-Sync (weiter oben in der Komponente definiert) verfügbar ist.
const PURCHASES_SYNC_BACKEND_BASE = 'https://rune-rewards-backend.maxkalinowski.workers.dev';
const cardShellStyle = {
  background: 'linear-gradient(165deg, #0C1F21 0%, #0A0A0A 100%)',
  border: '1px solid #172E30',
  borderRadius: 18,
  boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 28px -18px rgba(0,0,0,0.7)'
};
const cardIconBadgeStyle = {
  width: 30,
  height: 30,
  borderRadius: 9,
  background: '#112628',
  border: '1px solid #1E3A3C',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#CBDBDC',
  flexShrink: 0
};

// Exakte R-Form aus dem THORChain-Rune-Logo: ein durchgehender Zickzack-Strich
// (Stamm links, dann zwei Diagonalen für Schlaufe + Bein), keine Systemschrift.
// Nur das reine R (kein Kreis drumherum) — als durchgehender Zickzack-Strich:
// Stamm links, dann zwei Diagonalen für Schlaufe und Bein. Genug Rand im viewBox
// oben/unten, damit die abgerundeten Linienenden nicht angeschnitten werden.
// Exakt aus dem Original-Logo vermessene Form (per Farbanalyse der Pixel extrahiert):
// Stamm (senkrecht) als eigener Strich, plus Schlaufe+Bein als zusammenhängender
// Pfad, der oben am Stamm beginnt. So sieht es wirklich wie ein R aus.
const IconRuneR = p => {
  const gid = p.gradientId || 'runeRGrad';
  const size = p.size || 13;
  return /*#__PURE__*/React.createElement("svg", {
    width: size,
    height: size * (214 / 109),
    viewBox: "0 0 109 214",
    xmlns: "http://www.w3.org/2000/svg",
    style: {
      verticalAlign: 'middle',
      flexShrink: 0,
      display: 'inline-block',
      overflow: 'visible',
      ...(p.style || {})
    }
  }, !p.solid && /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: gid,
    x1: "10%",
    y1: "0%",
    x2: "90%",
    y2: "100%"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#00A8B0"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#33FFE6"
  }))), /*#__PURE__*/React.createElement("path", {
    d: "M13,0 L13,214 M13,0 L82,58 L59,112 L96,214",
    fill: "none",
    stroke: p.solid || `url(#${gid})`,
    strokeWidth: "27",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }));
};
const toolBtnStyle = active => ({
  width: 30,
  height: 30,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: active ? 'rgba(0,222,225,0.14)' : 'transparent',
  color: active ? '#00DEE1' : '#7C9698',
  border: `1px solid ${active ? 'rgba(0,222,225,0.55)' : '#1A3436'}`,
  borderRadius: 8,
  cursor: 'pointer'
});

// --- Simple custom SVG area chart with drawing tools (horizontal + free line) ---
// Wandelt eine Punktreihe in einen weichen, gerundeten SVG-Pfad um (statt scharfer
// Geraden zwischen den Punkten) -- verhindert vor allem bei sehr dichten/spitzen
// Live-Daten (z.B. 1H-Sekundenchart) den "blockigen" Treppen-Look.
function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

// Sortiert eine { date, value }-Zeitreihe chronologisch und entfernt doppelte Zeitstempel
// (letzter Wert je Datum gewinnt). Schützt die einfachen Übersichts-Charts (RUNE-Preis,
// Vergleichs-Chart) davor, bei nicht-sortierten oder doppelten API-Antworten wie kaputt/
// zerrissen auszusehen -- die einfachen Charts verbinden Punkte strikt in Array-Reihenfolge,
// anders als der große Kerzen-Chart, der intern über einen Index/Binärsuche arbeitet.
const sortAndDedupeSeries = series => {
  if (!Array.isArray(series) || series.length < 2) return series || [];
  const sorted = [...series].sort((a, b) => a.date - b.date);
  const deduped = [];
  for (const point of sorted) {
    if (deduped.length && deduped[deduped.length - 1].date === point.date) {
      deduped[deduped.length - 1] = point; // letzter Wert für dasselbe Datum gewinnt
    } else {
      deduped.push(point);
    }
  }
  return deduped;
};

// Entfernt Ausreißer, deren Wert um mehr als das 12-fache vom Median der Serie abweicht
// (nach oben oder unten). Ein einzelner kaputter/falsch geparster Preis-Punkt (z.B. eine
// fälschlich als 0 oder als absurd hohe Zahl interpretierte API-Antwort) würde sonst die
// komplette Y-Achsen-Skalierung des Charts verzerren: die eigentlichen, echten Kurswerte
// würden dann nur noch einen winzigen Streifen am oberen (oder unteren) Rand einnehmen,
// mit einem riesigen, leeren/wie abgeschnitten wirkenden Bereich für den Rest des Charts.
const rejectValueOutliers = series => {
  if (!Array.isArray(series) || series.length < 3) return series || [];
  const values = series.map(d => d.value).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return series;
  const median = values[Math.floor(values.length / 2)];
  if (!Number.isFinite(median) || median <= 0) return series;
  const filtered = series.filter(d => Number.isFinite(d.value) && d.value > median / 12 && d.value < median * 12);
  // Nur übernehmen, wenn dadurch nicht fast die ganze Serie wegfällt (sonst war der Median
  // selbst schon von zu vielen "Ausreißern" verzerrt, und der Filter würde mehr schaden als nützen).
  return filtered.length >= series.length * 0.8 ? filtered : series;
};


// WICHTIG: Der "zu wenig Daten"-Fall wird hier in einer eigenen, HOOK-FREIEN Hülle abgefangen --
// NICHT per frühem return innerhalb der eigentlichen Chart-Komponente. Ein früher return dort
// hätte zur Folge, dass beim ersten Rendern (noch keine Daten) deutlich weniger Hooks laufen als
// beim zweiten (Daten da sind). React bricht in dem Moment mit "Rendered more hooks than during
// the previous render" ab und reißt die GESAMTE App mit — der Bildschirm wird komplett schwarz.
// So bleibt die Hook-Reihenfolge in PortfolioChartInner immer identisch.
function PortfolioChart(props) {
  const {
    data,
    height = 240,
    lang
  } = props;
  const cleanData = useMemo(() => (data || []).filter(d => {
    if (!Number.isFinite(d.value)) return false;
    const hasOhlc = d.open != null || d.high != null || d.low != null;
    return !hasOhlc || Number.isFinite(d.open) && Number.isFinite(d.high) && Number.isFinite(d.low);
  }), [data]);
  if (!cleanData || cleanData.length < 2) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#7C9698',
        fontSize: 13
      }
    }, t('notEnoughData', lang));
  }
  return /*#__PURE__*/React.createElement(PortfolioChartInner, {
    ...props,
    data: cleanData
  });
}
function PortfolioChartInner({
  data,
  hideValues,
  lang,
  currency,
  storageKeyPrefix = 'tp',
  height = 240,
  showPriceRow = true,
  clampMinZero = true,
  dateFormatter = fmtDate,
  smooth = false,
  chartType = 'line',
  showHoverPriceLabel = true,
  allowDrawing = true,
  showAxis = true,
  restrictHoverToLine = false,
  allowMA200 = false,
  ma200OverrideSeries = null,
  showAreaFill = false,
  valueFormatter = null,
  allowZoom = false, // Zoomen/Verschieben (Mausrad, Pinch, Ziehen) auch für Linien-Charts erlauben,
  // nicht nur für Kerzen-Charts -- nutzt exakt dieselbe, bereits vorhandene Index-Fenster-Logik.
  allowRSI = false, // RSI(14)-Panel (mit Überkauft/Überverkauft-Zonen) auch für Linien-Charts
  // erlauben, nicht nur Kerzen -- braucht dafür keine OHLC-Daten, nur data[i].value.
  allowVolume = false // Volumen-Balken-Panel auch für Linien-Charts erlauben -- braucht dafür
  // data[i].volume je Punkt (z.B. von Binance-Kerzen mitgeliefert).
}) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState(null);

  // Zeichenwerkzeuge
  const [mode, setMode] = useState('pointer'); // 'pointer' | 'horizontal' | 'trend'
  const [lineToolMenuOpen, setLineToolMenuOpen] = useState(false); // Dropdown für Horizontal/Trendlinie (spart Platz gegenüber zwei einzelnen Buttons)
  const lineToolMenuRef = useRef(null);
  useEffect(() => {
    if (!lineToolMenuOpen) return;
    const onOutside = e => {
      if (lineToolMenuRef.current && !lineToolMenuRef.current.contains(e.target)) {
        setLineToolMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onOutside);
    return () => document.removeEventListener('pointerdown', onOutside);
  }, [lineToolMenuOpen]);
  const [hLines, setHLines] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKeyPrefix + '_hlines');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }); // { id, value }
  const [tLines, setTLines] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKeyPrefix + '_tlines');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }); // { id, x1,y1,x2,y2 } — Bruchteile 0..1 der Zeichenfläche
  // Rückgängig-Verlauf: merkt sich, in welcher Reihenfolge horizontale/Trendlinien NEU gezeichnet
  // wurden (nur die Erstellung, nicht jede Verschiebung) -- damit der Rückgängig-Button die
  // zuletzt gezeichnete Linie entfernen kann, unabhängig davon, ob es eine horizontale oder eine
  // Trendlinie war. Bewusst NICHT in localStorage persistiert (nur für die laufende Sitzung
  // relevant) und wird beim manuellen Löschen einer Linie über den Papierkorb-Button ebenfalls
  // bereinigt, damit Rückgängig nie ins Leere greift.
  const [drawHistory, setDrawHistory] = useState([]); // [{type:'h'|'t', id}]
  // Trendlinie wird jetzt in EINER durchgehenden Ziehbewegung gezeichnet (Antippen = Startpunkt,
  // Ziehen = Linie live verlängern, Loslassen = fertig) statt der früheren Zwei-Tap-Logik
  // (erst Start antippen, Hinweistext lesen, dann Endpunkt antippen). x1/y1 = Startpunkt
  // (fest), x2/y2 = aktuelle Zugposition (folgt live dem Finger/der Maus).
  const [pendingStart, setPendingStart] = useState(null); // { x1,y1,x2,y2 } in Achsen-Einheiten, oder null
  const [mousePixel, setMousePixel] = useState(null);
  const [dragging, setDragging] = useState(null);
  // Ausgewählte Zeichnung (persistent, NICHT an Maus-Hover gekoppelt) — wird per Klick/Tap
  // gesetzt und bleibt bestehen, bis auf eine leere Fläche geklickt oder gelöscht wird. Vorher
  // hing die Auswahl am Maus-Hover, wodurch sie beim Wegbewegen der Maus zum Löschen-Button
  // sofort wieder verschwand, bevor man klicken konnte.
  const [selectedId, setSelectedId] = useState(null);
  const [lineHoverId, setLineHoverId] = useState(null); // rein visuelles Hover-Feedback, unabhängig von der festen Auswahl
  const [showMA200, setShowMA200] = useState(() => {
    try {
      return localStorage.getItem(storageKeyPrefix + '_show_ma200') !== '0';
    } catch (e) {
      return true;
    }
  });
  const [showRSI, setShowRSI] = useState(() => {
    try {
      return localStorage.getItem(storageKeyPrefix + '_show_rsi') !== '0';
    } catch (e) {
      return true;
    }
  });
  const [showBB, setShowBB] = useState(() => {
    try {
      return localStorage.getItem(storageKeyPrefix + '_show_bb') === '1';
    } catch (e) {
      return false;
    }
  });
  const [logScale, setLogScale] = useState(() => {
    try {
      return localStorage.getItem(storageKeyPrefix + '_log_scale') === '1';
    } catch (e) {
      return false;
    }
  });
  const [showVolume, setShowVolume] = useState(() => {
    try {
      return localStorage.getItem(storageKeyPrefix + '_show_volume') !== '0';
    } catch (e) {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_show_ma200', showMA200 ? '1' : '0');
    } catch (e) {}
  }, [showMA200, storageKeyPrefix]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_show_rsi', showRSI ? '1' : '0');
    } catch (e) {}
  }, [showRSI, storageKeyPrefix]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_show_bb', showBB ? '1' : '0');
    } catch (e) {}
  }, [showBB, storageKeyPrefix]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_log_scale', logScale ? '1' : '0');
    } catch (e) {}
  }, [logScale, storageKeyPrefix]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_show_volume', showVolume ? '1' : '0');
    } catch (e) {}
  }, [showVolume, storageKeyPrefix]);

  // Rechter Rand wird größer, sobald mindestens eine horizontale Linie existiert — damit deren
  // Preis-Beschriftung in einer eigenen Spalte neben dem Chart Platz hat, statt auf der Kurve
  // selbst zu kleben und die Daten zu verdecken.
  // Der Portfolio-Wert-Chart (kein Kerzen-Chart) zeigt bewusst keine ständig sichtbaren
  // Achsen-Gitterlinien/-Zahlen mehr (schlanke Sparkline-Optik, wie beim Volumen-Sparkline) --
  // braucht deshalb auch keinen breiten Rand mehr dafür.
  const padding = showAxis ? {
    top: 16,
    right: 16,
    bottom: 28,
    left: 64
  } : {
    top: 16,
    right: 8,
    bottom: 20,
    left: 8
  };
  const isCandles = chartType === 'candles';
  // Fasst zusammen, ob die Index-Fenster-Zoom-/Verschiebe-Logik aktiv sein soll -- ursprünglich
  // nur für Kerzen-Charts gebaut, jetzt per allowZoom-Prop auch für einfache Linien-Charts (z.B.
  // den RUNE-Preis-Chart) nutzbar. Kerzen-spezifische Extras (RSI, Volumen, Bollinger, Log-Skala,
  // Kerzen-Rendering selbst) bleiben bewusst weiterhin an isCandles allein gebunden.
  const zoomEnabled = isCandles || allowZoom;
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Sofortige synchrone Breiten-Messung VOR dem ersten Bildaufbau -- verhindert, dass kurz
    // die Default-Breite (600px) gerendert wird, bevor die echte (auf dem Handy meist viel
    // schmalere) Breite über den ResizeObserver nachgereicht wird.
    setWidth(el.clientWidth || 600);
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Zeichnungen (horizontale Linien & Trendlinien) persistent speichern, damit sie nach einem Reload erhalten bleiben.
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_hlines', JSON.stringify(hLines));
    } catch (e) {}
  }, [hLines, storageKeyPrefix]);
  useEffect(() => {
    try {
      localStorage.setItem(storageKeyPrefix + '_tlines', JSON.stringify(tLines));
    } catch (e) {}
  }, [tLines, storageKeyPrefix]);

  // Zoomstufe (Kerzenbreite) & Verschiebung (welcher Ausschnitt sichtbar ist) werden pro Chart
  // WICHTIG: Zoomstufe & Bildausschnitt werden bewusst NICHT mehr über Sessions/Geräte hinweg
  // gespeichert (anders als Linien/Indikatoren) — das hat wiederholt zu einer kaputten Ansicht
  // geführt (Kerzen nur in einer kleinen Ecke, Rest leer), z.B. wenn die gespeicherte Position
  // von einem anderen Bildschirm oder einem älteren Datenstand stammte. Jeder Chart-Start
  // beginnt jetzt zuverlässig in der automatischen Standardansicht (letzte ~50 Kerzen).
  const [candleWidthPx, setCandleWidthPx] = useState(null); // px pro Kerze (isCandles) — null = automatisch (letzte ~50 Kerzen einpassen)
  const [viewStartIdx, setViewStartIdx] = useState(null); // Kerzen-Index (Kommazahl möglich) am linken Rand — null = automatisch
  const [panDrag, setPanDrag] = useState(null); // { startPx, startPy, startIdx, startYLo, startYHi }
  const [yZoomDomain, setYZoomDomain] = useState(null); // { yLo, yHi } — manuelle vertikale Verschiebung, null = automatisch ans sichtbare Fenster angepasst
  // Unabhängige, zusätzliche Absicherung: OB der Zoom-Zustand durch eine ECHTE Nutzeraktion
  // gesetzt wurde (Wheel, Ziehen, Pinch, +/- Knopf) — nicht nur, OB er gesetzt ist. Bisher wurde
  // "manueller Zoom" allein daran erkannt, dass candleWidthPx/viewStartIdx != null sind; das kann
  // aber im Prinzip auch durch einen Programmierfehler an ganz anderer Stelle passieren (z.B.
  // ein Event, das versehentlich durchgereicht wird), ohne dass der Mensch je etwas angefasst
  // hat. Mit diesem Flag lässt sich das unterscheiden UND — als Sicherheitsnetz — jeder
  // "Zoom", der ohne eine erfasste echte Interaktion zustande kam, beim nächsten Render
  // automatisch wieder verwerfen.
  const userInteractedRef = useRef(false);
  const CANDLE_W_MAX = 26; // Obergrenze — wie weit man reinzoomen kann

  // Beim Öffnen (bzw. bei Wechsel des Zeitraums) NICHT die komplette Historie auf einmal
  // zeigen, sondern mit den letzten ~50 Kerzen starten — übersichtlicher, und man kann jederzeit
  // rauszoomen, um mehr zu sehen.
  const N = data.length;
  const earliestDate = data && data.length ? data[0].date : null;
  const dataIdentityKey = `${earliestDate}|${N}`;
  const dataIdentityRef = useRef(dataIdentityKey);
  useEffect(() => {
    if (dataIdentityRef.current !== dataIdentityKey) {
      dataIdentityRef.current = dataIdentityKey;
      setYZoomDomain(null);
      setCandleWidthPx(null);
      setViewStartIdx(null);
    }
  }, [dataIdentityKey]);

  // (Der Fall "weniger als 2 Datenpunkte" wird bereits in der Hülle PortfolioChart abgefangen,
  // damit hier keine Hooks übersprungen werden können.)

  const innerW = Math.max(width - padding.left - padding.right, 10);
  const innerH = Math.max(height - padding.top - padding.bottom, 10);
  const xs = data.map(d => d.date);
  const fullXMin = Math.min(...xs),
    fullXMax = Math.max(...xs);
  // Untere Grenze fürs Rauszoomen: NICHT mehr fest auf einen Pixelwert begrenzt (das war der
  // Bug — irgendwann ging es einfach nicht mehr weiter raus). Stattdessen dynamisch an die
  // Datenmenge angepasst, sodass man immer bis zur kompletten sichtbaren Historie rauszoomen
  // kann, egal wie viele Kerzen das sind.
  const CANDLE_W_MIN = Math.min(7, Math.max(0.05, innerW / Math.max(N, 1)));

  // Obergrenze fürs Reinzoomen. WICHTIG: die feste Obergrenze von 26px darf nicht gelten, wenn
  // insgesamt so wenige Kerzen vorhanden sind, dass sie damit die Breite gar nicht füllen können.
  // Sonst kleben alle Kerzen als schmaler Block am linken Rand, rechts bleibt eine große leere
  // Fläche, und die Zeitachse läuft weit über die letzte Kerze hinaus in die Zukunft (weil das
  // sichtbare Fenster in Kerzen-Slots gerechnet wird, nicht in vorhandenen Kerzen). Bei wenigen
  // Kerzen wird die Kerze deshalb so breit, dass die vorhandenen Daten die Breite ausfüllen.
  const CANDLE_W_MAX_EFF = Math.max(CANDLE_W_MAX, innerW / Math.max(3, Math.min(50, N)));

  // Kerzen bekommen JEDE denselben festen Pixel-Abstand (Index-basiert), statt proportional zur
  // echten Kalenderzeit positioniert zu werden — bei unterschiedlich langen Kerzen (z.B. Monate
  // mit 28 vs. 31 Tagen) sorgte die alte zeitproportionale Positionierung sonst für ungleiche,
  // "quetschende" Abstände. Wie bei TradingView bleibt die Kerzenbreite pro Zoomstufe für alle
  // sichtbaren Kerzen exakt gleich; passen mehr Kerzen nicht in die Breite, wird gescrollt
  // (verschoben), statt sie zu stauchen.
  const dateToIdx = ts => {
    if (N === 1) return 0;
    if (ts <= data[0].date) return (ts - data[0].date) / (data[1].date - data[0].date || 1);
    if (ts >= data[N - 1].date) return N - 1 + (ts - data[N - 1].date) / (data[N - 1].date - data[N - 2].date || 1);
    let lo = 0,
      hi = N - 1;
    while (hi - lo > 1) {
      const mid = lo + hi >> 1;
      if (data[mid].date <= ts) lo = mid;else hi = mid;
    }
    return lo + (ts - data[lo].date) / (data[hi].date - data[lo].date || 1);
  };
  const idxToDate = i => {
    if (N === 1) return data[0].date;
    if (i <= 0) return data[0].date + i * (data[1].date - data[0].date || 1);
    if (i >= N - 1) return data[N - 1].date + (i - (N - 1)) * (data[N - 1].date - data[N - 2].date || 1);
    const lo = Math.floor(i),
      hi = Math.min(lo + 1, N - 1);
    return data[lo].date + (i - lo) * (data[hi].date - data[lo].date);
  };

  // Automatische Standardansicht (solange nicht gezoomt/verschoben wurde): bei Kerzen-Charts
  // füllen die letzten ~50 Kerzen die Breite. Bei einfachen Linien-Charts mit aktiviertem Zoom
  // (allowZoom, z.B. der RUNE-Preis-Chart) bleibt der bisherige, gewohnte Startzustand erhalten
  // -- die GESAMTE gewählte Zeitspanne ist von Anfang an sichtbar; erst ein aktiver Zoom (Wheel/
  // Pinch/Ziehen) blendet auf einen kleineren Ausschnitt.
  const autoWidthPx = isCandles ? Math.min(CANDLE_W_MAX_EFF, Math.max(CANDLE_W_MIN, innerW / Math.min(50, N))) : Math.min(CANDLE_W_MAX_EFF, Math.max(CANDLE_W_MIN, innerW / Math.max(1, N)));
  // WICHTIG: ein aus localStorage wiederhergestellter Wert kann von einem GANZ ANDEREN Bildschirm
  // (anderes innerW) oder Datensatz (anderes N) stammen — deshalb hier IMMER gegen die aktuell
  // gültigen Grenzen klemmen, statt dem gespeicherten Rohwert blind zu vertrauen. Das verhindert
  // eine degenerierte (zu winzige/riesige) Kerzenbreite, die sonst den ganzen Chart unsichtbar
  // machen könnte.
  const candleWidthPxEff = zoomEnabled ? Math.min(CANDLE_W_MAX_EFF, Math.max(CANDLE_W_MIN, candleWidthPx != null ? candleWidthPx : autoWidthPx)) : autoWidthPx;
  const visibleCount = zoomEnabled ? innerW / candleWidthPxEff : N;
  const autoStartIdx = Math.max(0, N - visibleCount);
  const rawViewStartIdxEff = viewStartIdx != null ? viewStartIdx : autoStartIdx;
  // Sicherheitsnetz: eine (z.B. von einem anderen Bildschirm/Session gespeicherte) Zoom-/
  // Verschiebeposition kann rechnerisch gültig, aber praktisch witzlos sein — z.B. wenn sie
  // größtenteils in den leeren Bereich VOR der ersten oder NACH der letzten echten Kerze zeigt
  // (der "Zukunfts"-Bereich ist bewusst frei begehbar, u.a. fürs Zeichnen von Trendlinien). Statt
  // dann einen fast komplett leeren Chart zu zeigen: erkennen und auf die Standardansicht
  // zurückfallen (und den gespeicherten Zustand verwerfen, damit es nicht wieder passiert).
  const overlapCount = Math.max(0, Math.min(N, rawViewStartIdxEff + visibleCount) - Math.max(0, rawViewStartIdxEff));
  // Dritte, unabhängige Prüfung: unabhängig davon, WARUM ein übernommener Zoom danebenliegt
  // (falsche Position, falsche Breite, oder ein subtilerer Grund) — zählen wir direkt nach, wie
  // viele der Kerzen, die dieser Zoom gerade zeigen würde, überhaupt echte, zeichenbare
  // OHLC-Werte haben. Liegt der Anteil niedrig, ist der Zoom für die AKTUELLEN Daten unbrauchbar,
  // ganz gleich, welche Rechnung ihn ursprünglich dorthin gebracht hat.
  const candidateLo = Math.max(0, Math.floor(rawViewStartIdxEff));
  const candidateHi = Math.min(N, Math.ceil(rawViewStartIdxEff + visibleCount));
  const candidateSlice = candidateHi > candidateLo ? data.slice(candidateLo, candidateHi) : [];
  const renderableInCandidate = candidateSlice.filter(d => isCandles ? Number.isFinite(d.open) && Number.isFinite(d.high) && Number.isFinite(d.low) && Number.isFinite(d.value) : Number.isFinite(d.value)).length;
  const dataIsSane = candidateSlice.length === 0 || renderableInCandidate / candidateSlice.length >= 0.8;
  // Zwei weitere Weisen, wie ein übernommener Zoom "unsinnig" sein kann:
  //  (a) die POSITION zeigt größtenteils in den leeren Bereich vor/nach den echten Kerzen, oder
  //  (b) die BREITE selbst passt nicht mehr zur aktuellen Kerzenzahl — z.B. wenn candleWidthPx
  //      noch von einem Datensatz mit deutlich mehr Kerzen stammt und jetzt, bei weniger Kerzen,
  //      mehr sichtbare Slots verlangt, als überhaupt an Kerzen existiert. Ohne diese Prüfungen
  //      könnte (a)/(b) fälschlich als "sinnvoll" durchgehen (Position/Breite liegen ja
  //      rechnerisch innerhalb der Daten), während trotzdem ein großer leerer Rest sichtbar bleibt.
  const widthIsSane = visibleCount <= N * 1.5;
  const hasUnexplainedZoom = (candleWidthPx != null || viewStartIdx != null) && !userInteractedRef.current;
  // WICHTIG: Ist die aktuelle Position/Breite auf eine ECHTE Nutzeraktion zurückzuführen
  // (userInteractedRef.current), wird sie IMMER als sinnvoll akzeptiert -- auch wenn man dabei
  // weit nach rechts in den leeren Bereich hinter der letzten Kerze verschoben/gezoomt hat. Genau
  // das ist ja gewollt (siehe Kommentar oben: frei begehbarer "Zukunfts"-Bereich, u.a. fürs
  // Zeichnen von Trendlinien) und darf NICHT dazu führen, dass der Chart mitten in der Aktion
  // wieder auf die Standardansicht zurückspringt. Die überlapp-/breiten-basierten Prüfungen unten
  // greifen deshalb nur noch für einen NICHT selbst ausgelösten Zustand (z.B. ein technisch
  // übernommener, aber inzwischen nicht mehr passender Wert) -- ein Fall, der durch
  // hasUnexplainedZoom ohnehin schon separat abgedeckt ist.
  const viewIsSane = !zoomEnabled || userInteractedRef.current || widthIsSane && dataIsSane && !hasUnexplainedZoom && overlapCount >= Math.min(5, N) && overlapCount >= visibleCount * 0.8;
  const viewStartIdxEff = viewIsSane ? rawViewStartIdxEff : autoStartIdx;
  const isZoomed = zoomEnabled && (candleWidthPx != null || viewStartIdx != null || yZoomDomain != null);
  useEffect(() => {
    if (zoomEnabled && !viewIsSane) {
      setCandleWidthPx(null);
      setViewStartIdx(null);
      setYZoomDomain(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewIsSane, zoomEnabled]);

  // xMin/xMax weiterhin als Zeitspanne (für Y-Achsen-Autoscale und Achsenbeschriftung unten),
  // jetzt aus dem Index-Fenster abgeleitet statt umgekehrt. Nach rechts bewusst KEINE
  // Begrenzung — man soll beliebig weit in die "Zukunft" navigieren können (z.B. für Trendlinien).
  const xMin = zoomEnabled ? idxToDate(viewStartIdxEff) : fullXMin;
  const xMax = zoomEnabled ? idxToDate(viewStartIdxEff + visibleCount) : fullXMax;
  // Y-Achse passt sich an das an, was gerade sichtbar ist (Zoom/Verschieben) — wie bei
  // TradingView & Co. Der vorherige "Stretch"-Bug kam nicht davon, sondern von der separaten,
  // inzwischen entfernten manuellen Vertikal-Verschiebung.
  const dataInView = data.filter(d => d.date >= xMin && d.date <= xMax);
  const yBasis = dataInView.length >= 2 ? dataInView : data;
  const ys = isCandles ? yBasis.flatMap(d => [d.high != null ? d.high : d.value, d.low != null ? d.low : d.value]) : yBasis.map(d => d.value);
  // Absicherung: falls ys aus irgendeinem Grund leer oder nur nicht-endliche Werte enthält
  // (würde Math.min/max sonst zu Infinity/-Infinity/NaN machen und dadurch den GESAMTEN Chart
  // unsichtbar rendern), auf die volle Datenreihe zurückfallen.
  const ysFinite = ys.filter(Number.isFinite);
  const ysSafe = ysFinite.length ? ysFinite : data.flatMap(d => [d.high != null ? d.high : d.value, d.low != null ? d.low : d.value]).filter(Number.isFinite);
  const yMin = ysSafe.length ? Math.min(...ysSafe) : 0;
  const yMax = ysSafe.length ? Math.max(...ysSafe) : 1;
  const yPad = (yMax - yMin) * 0.1 || yMax * 0.1 || 1;
  // Log-Modus ist beim Kerzenchart UND bei Linien-Charts mit aktiviertem Zoom (allowZoom, z.B.
  // der RUNE-Preis-Chart) verfügbar (Umschalter wird nur dort angezeigt) — als Absicherung hier
  // trotzdem explizit gegen zoomEnabled verundet, damit ein gemeinsam genutzter localStorage-Wert
  // nie versehentlich den Portfolio-Wert-Chart (ohne Zoom) umschaltet.
  const isLogScale = logScale && zoomEnabled;
  // Im Log-Modus wird mit einem Faktor statt einem Absolutbetrag gepolstert (sonst würde die
  // Polsterung bei kleinen Preisen unverhältnismäßig groß bzw. bei großen zu klein wirken), und
  // NIE auf 0 geklemmt — log(0) ist nicht definiert, Kryptopreise sind ohnehin immer > 0.
  const yLoAuto = isLogScale ? Math.max(yMin * 0.95, 1e-9) : clampMinZero ? Math.max(0, yMin - yPad) : yMin - yPad;
  const yHiAuto = isLogScale ? yMax * 1.05 : yMax + yPad;
  const yLo = zoomEnabled && yZoomDomain ? yZoomDomain.yLo : yLoAuto;
  const yHi = zoomEnabled && yZoomDomain ? yZoomDomain.yHi : yHiAuto;
  const logLo = Math.log(Math.max(yLo, 1e-9));
  const logHi = Math.log(Math.max(yHi, Math.max(yLo, 1e-9) * 1.0001));
  const yScale = isLogScale ? y => padding.top + innerH - (Math.log(Math.max(y, 1e-9)) - logLo) / (logHi - logLo || 1) * innerH : y => padding.top + innerH - (y - yLo) / (yHi - yLo || 1) * innerH;
  const invYScale = isLogScale ? py => Math.exp(logLo + (1 - (py - padding.top) / innerH) * (logHi - logLo)) : py => yLo + (1 - (py - padding.top) / innerH) * (yHi - yLo);
  const xScale = zoomEnabled ? x => padding.left + (dateToIdx(x) - viewStartIdxEff) * candleWidthPxEff : x => padding.left + (x - xMin) / (xMax - xMin || 1) * innerW;
  const invXScale = zoomEnabled ? px => idxToDate(viewStartIdxEff + (px - padding.left) / candleWidthPxEff) : px => xMin + (px - padding.left) / innerW * (xMax - xMin);

  // Mausrad/Trackpad-Scroll: rein-/rauszoomen, zentriert auf die Cursor-Position (die Zeit
  // unter dem Mauszeiger bleibt beim Zoomen an derselben Stelle stehen). Die Kerzenbreite ändert
  // sich dabei einheitlich für ALLE sichtbaren Kerzen (fester Wert je Zoomstufe, kein Stauchen).
  // Der Zoom-Schritt ist jetzt PROPORTIONAL zur tatsächlichen deltaY-Größe des Events statt eines
  // festen Faktors -- ein Trackpad (viele kleine Events pro Wischgeste) zoomt dadurch fein und
  // gleichmäßig statt sprunghaft, während ein klassisches Mausrad (wenige große Events) weiterhin
  // spürbare, aber keine übertrieben harten Sprünge macht. Zusätzlich werden mehrere Events, die
  // innerhalb desselben Frames eintreffen (bei einem Trackpad können das sehr viele sein), zu
  // EINEM Render pro Animationsframe gebündelt -- das nimmt dem Zoomen das "Ruckeln".
  const wheelZoomRef = useRef({
    raf: null,
    deltaSum: 0,
    pt: null
  });
  useEffect(() => () => {
    if (wheelZoomRef.current.raf != null) cancelAnimationFrame(wheelZoomRef.current.raf);
  }, []);
  const handleWheel = e => {
    if (!zoomEnabled) return; // Zoom nur, wo erlaubt (Kerzen-Charts oder allowZoom), nicht beim Portfolio-Wert-Chart
    e.preventDefault();
    const pt = getLocalPoint(e);
    const wz = wheelZoomRef.current;
    wz.deltaSum += e.deltaY;
    wz.pt = pt;
    if (wz.raf != null) return; // für diesen Frame schon eines geplant -- weitere Events werden nur aufsummiert
    wz.raf = requestAnimationFrame(() => {
      wz.raf = null;
      const deltaY = wz.deltaSum;
      const localPt = wz.pt;
      wz.deltaSum = 0;
      // Auf eine sinnvolle Spanne gedeckelt, damit ein einzelnes extremes Event (manche Mäuse
      // melden pro Rastung sehr große Werte) nicht zu einem harten Sprung führt.
      const clampedDelta = Math.max(-220, Math.min(220, deltaY));
      const zoomFactor = Math.pow(1.00095, -clampedDelta); // deltaY>0 = rauszoomen -> Kerzen schmaler
      const cursorIdx = viewStartIdxEff + (localPt.x - padding.left) / candleWidthPxEff;
      const newWidth = Math.min(CANDLE_W_MAX_EFF, Math.max(CANDLE_W_MIN, candleWidthPxEff * zoomFactor));
      let newStart = cursorIdx - (localPt.x - padding.left) / newWidth;
      const newVisibleCount = innerW / newWidth;
      newStart = Math.max(newStart, -3); // etwas Luft, aber nicht beliebig weit vor die erste Kerze
      newStart = Math.min(newStart, Math.max(-3, N - newVisibleCount * 0.3)); // beim Zoomen (anders als beim bewussten Verschieben) nicht komplett in den leeren Bereich nach der letzten Kerze geraten
      userInteractedRef.current = true;
      setCandleWidthPx(newWidth);
      setViewStartIdx(newStart);
      setYZoomDomain(null);
    });
  };

  // Feste +/- Zoom-Buttons als zuverlässige Alternative zum Pinch-Gesture — manche mobilen
  // Browser fangen Zwei-Finger-Gesten trotz touch-action:none uneinheitlich ab, daher hier ein
  // Weg, der immer funktioniert (zoomt zur Mitte der aktuellen Ansicht).
  const zoomByFactor = factor => {
    if (!zoomEnabled) return;
    const centerPx = padding.left + innerW / 2;
    const cursorIdx = viewStartIdxEff + (centerPx - padding.left) / candleWidthPxEff;
    const newWidth = Math.min(CANDLE_W_MAX_EFF, Math.max(CANDLE_W_MIN, candleWidthPxEff * factor));
    let newStart = cursorIdx - (centerPx - padding.left) / newWidth;
    const newVisibleCount = innerW / newWidth;
    newStart = Math.max(newStart, -3);
    newStart = Math.min(newStart, Math.max(-3, N - newVisibleCount * 0.3));
    userInteractedRef.current = true;
    setCandleWidthPx(newWidth);
    setViewStartIdx(newStart);
    setYZoomDomain(null);
  };

  // WICHTIG: Trendlinien (und der Ziehpunkt beim Zeichnen) werden in ECHTEN Werten gespeichert
  // (Datum + Preis), NICHT als Bruchteil (0..1) der aktuellen Ansicht. Ein Bruchteil würde beim
  // Zoomen/Verschieben gegen ein anderes xMin/xMax/yLo/yHi-Fenster neu interpretiert und die
  // Linie so an eine falsche Stelle "springen" lassen — echte Werte bleiben dagegen immer an
  // ihrem Datum/Preis, exakt wie bei horizontalen Linien.
  const toAbs = pt => ({
    x: invXScale(pt.x),
    y: invYScale(pt.y)
  });
  const fromAbs = a => ({
    x: xScale(a.x),
    y: yScale(a.y)
  });
  const getLocalPoint = e => {
    const rect = svgRef.current.getBoundingClientRect();
    // Bei echten TouchEvents (touchmove/touchstart) gibt es kein e.clientX/Y direkt am Event --
    // das steckt in e.touches[0] (bzw. e.changedTouches[0] bei touchend). Ohne diese Fallback-
    // Kette lieferte ein raw TouchEvent NaN-Koordinaten, was das Ziehen einer Trendlinie auf dem
    // Handy ruckelig/kaputt aussehen ließ. Pointer-/Mouse-Events haben clientX/Y direkt am
    // Event, dafür greift `|| e` am Ende.
    const src = e.touches && e.touches[0] || e.changedTouches && e.changedTouches[0] || e;
    return {
      x: src.clientX - rect.left,
      y: src.clientY - rect.top
    };
  };
  const chartPoints = data.map(d => ({
    x: xScale(d.date),
    y: yScale(d.value)
  }));
  const straightLinePath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const smoothLinePath = smooth ? smoothPath(chartPoints) : straightLinePath;
  const smoothAreaPath = chartPoints.length ? `${smoothLinePath} L ${chartPoints[chartPoints.length - 1].x},${padding.top + innerH} L ${chartPoints[0].x},${padding.top + innerH} Z` : '';

  // Kerzen-Geometrie: jede tatsächliche Kerze wird gerendert (keine Ausdünnung mehr) — seit
  // die 4H-Option entfernt wurde, bleibt die maximale Kerzenzahl (z.B. 1D über Jahre ≈ 2000)
  // klein genug, um direkt gerendert zu werden, ohne dass Kerzen fehlen oder Lücken entstehen.
  // Etwas Rand links/rechts der sichtbaren Fläche mitrendern, damit beim Verschieben keine
  // Kerze abrupt am Bildschirmrand auftaucht/verschwindet.
  const candleSourceData = isCandles ? data.filter(d => d.date >= idxToDate(viewStartIdxEff - 2) && d.date <= idxToDate(viewStartIdxEff + visibleCount + 2)) : dataInView.length ? dataInView : data;
  const visibleCandleCount = Math.max(1, candleSourceData.length);
  const candleBodyW = Math.max(1, Math.min(candleWidthPxEff * 0.94, 22));
  const candles = isCandles ? candleSourceData.map(d => {
    const cx = xScale(d.date);
    const o = d.open != null ? d.open : d.value;
    const c = d.value;
    const h = d.high != null ? d.high : Math.max(o, c);
    const l = d.low != null ? d.low : Math.min(o, c);
    const up = c >= o;
    return {
      x: cx,
      wickTop: yScale(h),
      wickBottom: yScale(l),
      bodyTop: yScale(Math.max(o, c)),
      bodyBottom: yScale(Math.min(o, c)),
      up
    };
  }).filter(c => Number.isFinite(c.x) && Number.isFinite(c.wickTop) && Number.isFinite(c.wickBottom) && Number.isFinite(c.bodyTop) && Number.isFinite(c.bodyBottom)) : [];

  // MA200 (gleitender 200er-Durchschnitt) — als Sliding-Window-Summe berechnet (O(n) statt
  // O(n·200)), damit es auch bei mehreren tausend Kerzen (max. Historie) flüssig bleibt.
  // Bei kurzen Zeiträumen (7T/30T/90T) hat der Chart selbst oft weit weniger als 200 eigene
  // Kerzen -- eine "echte" 200-TAGE-Linie würde dort nie erscheinen. Wird ein fertig
  // berechneter, auf Tagesbasis beruhender ma200OverrideSeries übergeben (siehe RUNE-
  // Preis-Übersicht), wird DIESER stattdessen verwendet (auf den sichtbaren Zeitraum
  // zugeschnitten) -- er zeigt so auch bei kurzen Zeiträumen zuverlässig die echten letzten
  // 200 Tage an, statt nur bei 1 Jahr sichtbar zu sein.
  const MA_PERIOD = 200;
  const ma200Series = [];
  if (allowMA200 && ma200OverrideSeries && ma200OverrideSeries.length) {
    const pad = (fullXMax - fullXMin) * 0.02;
    for (const d of ma200OverrideSeries) {
      if (d.date >= fullXMin - pad && d.date <= fullXMax + pad) ma200Series.push(d);
    }
  } else if (isCandles || allowMA200) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i].value;
      if (i >= MA_PERIOD) sum -= data[i - MA_PERIOD].value;
      if (i >= MA_PERIOD - 1) ma200Series.push({
        date: data[i].date,
        value: sum / MA_PERIOD
      });
    }
  }
  const ma200Points = ma200Series.map(d => ({
    x: xScale(d.date),
    y: yScale(d.value)
  }));
  const ma200Path = ma200Points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  // RSI(14) nach der üblichen Wilder-Glättung. Läuft jetzt auch für Linien-Charts mit
  // allowRSI=true (z.B. RUNE-Preis-Übersicht), nicht mehr nur für Kerzen-Charts.
  const RSI_PERIOD = 14;
  const rsiSeries = [];
  if ((isCandles || allowRSI) && data.length > RSI_PERIOD) {
    let avgGain = 0,
      avgLoss = 0;
    for (let i = 1; i <= RSI_PERIOD; i++) {
      const change = data[i].value - data[i - 1].value;
      if (change > 0) avgGain += change;else avgLoss -= change;
    }
    avgGain /= RSI_PERIOD;
    avgLoss /= RSI_PERIOD;
    rsiSeries.push({
      date: data[RSI_PERIOD].date,
      rsi: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
    });
    for (let i = RSI_PERIOD + 1; i < data.length; i++) {
      const change = data[i].value - data[i - 1].value;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
      rsiSeries.push({
        date: data[i].date,
        rsi: avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
      });
    }
  }
  const RSI_HEIGHT = isCandles || allowRSI ? 70 : 0;
  const RSI_PAD = 6;
  const rsiYScale = v => RSI_PAD + (1 - v / 100) * (RSI_HEIGHT - RSI_PAD * 2);
  const rsiPoints = rsiSeries.map(d => ({
    x: xScale(d.date),
    y: rsiYScale(d.rsi)
  }));
  const rsiPath = rsiPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');

  // Volumen: bei Kerzen weiterhin ein eigenes kleines Panel unter dem Chart (candleSourceData,
  // feste Kerzenbreite). Bei Linien-Charts (allowVolume) dagegen KEIN eigenes Panel mehr, sondern
  // Balken direkt unten IM Haupt-Chart selbst (siehe volOverlay* weiter unten) -- damit es
  // eindeutig wie Teil DES EINEN Charts aussieht und nicht wie ein zweiter, separater Chart.
  const VOLUME_HEIGHT = isCandles ? 46 : 0;
  const volSourceData = isCandles ? candleSourceData : allowVolume ? dataInView.length ? dataInView : data : [];
  const volSeriesRender = volSourceData.filter(d => d.volume != null);
  const volMax = volSeriesRender.length ? Math.max(...volSeriesRender.map(d => d.volume), 1e-9) : 1;
  const volYScale = v => VOLUME_HEIGHT - v / volMax * (VOLUME_HEIGHT - 4);
  const volBarW = isCandles ? Math.max(1, candleWidthPxEff * 0.7) : Math.max(1, Math.min(innerW / Math.max(1, volSeriesRender.length) * 0.6, 10));
  // Geometrie für die IN-Chart-Volumenbalken (Linien-Charts): unterste ~24% der Chart-Höhe
  // reserviert, Balken wachsen von der X-Achse (unten) nach oben, halbtransparent, HINTER der
  // Preislinie gezeichnet.
  const VOL_OVERLAY_FRAC = 0.24;
  const volOverlayBottom = padding.top + innerH;
  const volOverlayTop = padding.top + innerH * (1 - VOL_OVERLAY_FRAC);
  const volOverlayBarH = v => Math.max(1, v / volMax * (volOverlayBottom - volOverlayTop));

  // Bollinger Bands (20er SMA ± 2 Standardabweichungen) — als Overlay im Haupt-Chart.
  const BB_PERIOD = 20;
  const bbSeries = [];
  if (isCandles && data.length >= BB_PERIOD) {
    let sum = 0,
      sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i].value;
      sumSq += data[i].value * data[i].value;
      if (i >= BB_PERIOD) {
        sum -= data[i - BB_PERIOD].value;
        sumSq -= data[i - BB_PERIOD].value ** 2;
      }
      if (i >= BB_PERIOD - 1) {
        const mean = sum / BB_PERIOD;
        const variance = Math.max(0, sumSq / BB_PERIOD - mean * mean);
        const std = Math.sqrt(variance);
        bbSeries.push({
          date: data[i].date,
          mid: mean,
          upper: mean + 2 * std,
          lower: mean - 2 * std
        });
      }
    }
  }
  const bbUpperPath = bbSeries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.date)} ${yScale(d.upper)}`).join(' ');
  const bbLowerPath = bbSeries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.date)} ${yScale(d.lower)}`).join(' ');
  const bbMidPath = bbSeries.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(d.date)} ${yScale(d.mid)}`).join(' ');
  const yTicks = 4;
  const yTickVals = isLogScale ? Array.from({
    length: yTicks + 1
  }, (_, i) => Math.exp(logLo + i * (logHi - logLo) / yTicks)) : Array.from({
    length: yTicks + 1
  }, (_, i) => yLo + i * (yHi - yLo) / yTicks);
  // Nachkommastellen für die Achsenbeschriftung an die Tick-Abstände anpassen — sonst
  // rundet z.B. ein RUNE-Preis um $0.40 bei jedem Tick auf "$0" und die Achse wirkt sinnlos.
  const yTickStep = (yHi - yLo) / yTicks || 1;
  const yTickDecimals = isCandles ? 3 : yTickStep >= 1 ? 0 : yTickStep >= 0.1 ? 2 : yTickStep >= 0.01 ? 3 : 4;

  // Zentrale Formatierungsfunktion für alle Preis-Beschriftungen im Chart (Y-Achse, horizontale
  // Linien, Live-Preis-Label, Crosshair-Hover-Label). Nutzt standardmäßig die gewählte Fiat-
  // Währung, kann aber über valueFormatter komplett überschrieben werden -- z.B. für den
  // RUNE/BTC- oder RUNE/ETH-Kurs, der weder eine Fiat-Währung noch dieselbe Nachkommastellen-
  // Logik braucht.
  const formatValueLabel = v => {
    if (hideValues) return '••••';
    if (valueFormatter) return valueFormatter(v, lang);
    return `${getCurrencySymbol(currency)}${v.toLocaleString(localeFor(lang), {
      minimumFractionDigits: yTickDecimals,
      maximumFractionDigits: yTickDecimals
    })}`;
  };

  // Anzahl der x-Achsen-Beschriftungen an die verfügbare Breite anpassen, statt immer fix 6 zu
  // zeigen — auf schmalen (Handy-)Bildschirmen quetschen sich sonst z.B. Uhrzeiten wie
  // "10:43:46 AM" im 4H-Chart ineinander. Uhrzeiten brauchen mehr Platz pro Label als Daten.
  const isTimeFormat = dateFormatter === fmtTime || dateFormatter === fmtHourMin;
  const minLabelSpacing = isTimeFormat ? 92 : 64;
  const maxTicksByWidth = Math.max(2, Math.floor(innerW / minLabelSpacing));
  // Nie mehr Ticks anzeigen, als es unterschiedliche Kalendertage im sichtbaren Fenster gibt --
  // sonst sehen bei einem sehr schmalen Fenster (z.B. der 1-Tages-Ansicht) mehrere Ticks
  // dieselbe Tag+Monat-Beschriftung, weil sie auf denselben Kalendertag fallen (Bug: z.B.
  // "29. Jul / 29. Jul / 30. Jul" statt drei unterschiedlicher Tage wie im Wochen-/
  // Dreimonats-Chart). Die Formatierung selbst bleibt exakt dieselbe (Tag+Monat, keine Uhrzeit)
  // wie in den anderen Zeiträumen -- es werden nur nie mehr eindeutige Ticks verlangt, als
  // tatsächlich vorhanden sind.
  const uniqueDaysInView = isTimeFormat ? Infinity : Math.max(1, Math.round((xMax - xMin) / (24 * 60 * 60 * 1000)) + 1);
  const xTickCountRaw = Math.min(6, maxTicksByWidth, data.length);
  const xTickCount = Math.max(2, Math.min(xTickCountRaw, uniqueDaysInView));
  const xTickVals = Array.from({
    length: xTickCount
  }, (_, i) => xMin + i * (xMax - xMin) / (xTickCount - 1 || 1));
  const longPressTimerRef = useRef(null);
  const touchPendingRef = useRef(null); // { x, y } — Position während der kurzen Entscheidungsphase (Verschieben vs. Long-Press-Crosshair)
  // Trendlinie zeichnen: EINE durchgehende Zieh-Geste (Antippen = Start, Ziehen = Verlängern,
  // Loslassen = fixieren). Dieser Ref merkt sich die Pixel-Position vom Antippen und die zuletzt
  // bekannte Position während des Ziehens, um beim Loslassen zu prüfen, ob überhaupt tatsächlich
  // gezogen wurde (siehe MIN_DRAG_PX weiter unten) -- ein reiner Tap ohne Bewegung soll keine
  // (kaum sichtbare) Mini-Linie erzeugen.
  const trendDrawPixelRef = useRef(null);
  // Zählt die aktuell aufliegenden Finger (über die nativen Touch-Listener unten aktuell
  // gehalten). Wird gebraucht, damit das EIN-Finger-Verschieben/Fadenkreuz (über die separaten
  // Pointer-Events unten) sich zuverlässig komplett zurückzieht, sobald ein zweiter Finger
  // dazukommt — sonst kann es je nach Browser/Event-Reihenfolge mit dem Pinch-Zoom kollidieren
  // und z.B. das Rauszoomen (Finger zusammenführen) blockieren oder verfälschen.
  const activeTouchCountRef = useRef(0);
  const [crosshairActive, setCrosshairActive] = useState(false); // per Long-Press aktiviertes, frei bewegliches Fadenkreuz (Touch)

  const updateHoverAt = pt => {
    const targetX = xMin + (pt.x - padding.left) / innerW * (xMax - xMin);
    let closest = data[0];
    let minDiff = Infinity;
    for (const d of data) {
      const diff = Math.abs(d.date - targetX);
      if (diff < minDiff) {
        minDiff = diff;
        closest = d;
      }
    }
    if (restrictHoverToLine) {
      // Nur reagieren, wenn der Finger/Cursor tatsächlich nah an der Graphenlinie ist -- nicht
      // irgendwo im leeren Bereich darüber/darunter. Toleranz großzügig genug für einen Finger,
      // aber nicht der ganze Chart. Der Wert klebt dann an der Linie (dem echten Datenpunkt),
      // statt frei der rohen Finger-Höhe zu folgen.
      const lineY = yScale(closest.value);
      const tolerancePx = 26;
      if (Math.abs(pt.y - lineY) > tolerancePx) {
        setHover(null);
        return;
      }
      setHover({
        ...closest,
        value: closest.value
      });
      return;
    }
    // Datum an die nächste Kerze angeglichen, aber der PREIS folgt der tatsächlichen
    // Position (nicht fix auf den Schlusskurs) — genau wie bei TradingView, wo das
    // Crosshair den Preis an genau der Höhe zeigt, wo der Cursor/Finger ist.
    setHover({
      ...closest,
      value: invYScale(pt.y)
    });
  };
  const clearTouchCrosshairState = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    touchPendingRef.current = null;
    if (crosshairActive) {
      setCrosshairActive(false);
      setHover(null);
    }
  };

  // Sicherheitsnetz: falls das Loslassen nicht direkt auf dem SVG-Element ankommt (z.B. Finger
  // rutscht beim Loslassen leicht daneben), trotzdem zuverlässig aufräumen.
  useEffect(() => {
    window.addEventListener('pointerup', clearTouchCrosshairState);
    window.addEventListener('touchend', clearTouchCrosshairState);
    window.addEventListener('touchcancel', clearTouchCrosshairState);
    return () => {
      window.removeEventListener('pointerup', clearTouchCrosshairState);
      window.removeEventListener('touchend', clearTouchCrosshairState);
      window.removeEventListener('touchcancel', clearTouchCrosshairState);
    };
  }, [crosshairActive]);
  const handleSvgMouseMove = e => {
    if (pinchStateRef.current || e.pointerType === 'touch' && activeTouchCountRef.current >= 2) return; // während des Pinchens (bzw. sobald ein 2. Finger da ist) keinen Crosshair/Verschieben setzen — sonst "melden" beide Finger je eine Position bzw. kollidiert es mit dem Pinch-Zoom
    const pt = getLocalPoint(e);
    if (mode === 'trend' && pendingStart) {
      // Trendlinie in der "Endpunkt platzieren"-Phase: die Linie folgt live der Maus (Hover,
      // kein Klick nötig) bzw. dem Finger (während er den Chart berührt) -- unabhängig davon,
      // ob dieselbe Berührung schon beim ersten Tap aktiv war.
      const a = toAbs(pt);
      setPendingStart(prev => prev ? {
        ...prev,
        x2: a.x,
        y2: a.y
      } : prev);
      setMousePixel(pt);
      return;
    }
    if (e.pointerType === 'touch') {
      if (crosshairActive) {
        setMousePixel(pt);
        updateHoverAt(pt); // Fadenkreuz frei mit dem Finger mitziehen
        return;
      }
      if (touchPendingRef.current) {
        const dist = Math.hypot(pt.x - touchPendingRef.current.x, pt.y - touchPendingRef.current.y);
        if (dist > 10) {
          // Eindeutig eine Wischbewegung, kein Long Press -> jetzt normal verschieben.
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
          const startPt = touchPendingRef.current;
          touchPendingRef.current = null;
          userInteractedRef.current = true;
          setPanDrag({
            startPx: startPt.x,
            startPy: startPt.y,
            startIdx: viewStartIdxEff,
            startYLo: yLo,
            startYHi: yHi
          });
        }
        return; // während der kurzen Entscheidungsphase noch keinen normalen Hover setzen
      }
    }
    setMousePixel(pt);
    if (mode === 'pointer' && !dragging && !panDrag) {
      updateHoverAt(pt);
    } else {
      setHover(null);
    }
  };

  // Bug-Fix: Tippen/Klicken auf eine Linie (um sie auszuwählen) hat vorher sofort wieder
  // funktioniert wie "abwählen", weil auf den pointerDown der Linie noch ein normales
  // "click"-Event auf das SVG folgt und bubbled — das hat die gerade gesetzte Auswahl
  // (selectedId) im selben Moment wieder gelöscht. justInteractedRef markiert genau diesen
  // einen folgenden Klick als "schon behandelt", damit die Auswahl bestehen bleibt.
  const justInteractedRef = useRef(false);
  // Merkt sich die Pixel-Position beim Drücken (für JEDEN Modus) -- damit beim Loslassen
  // unterschieden werden kann, ob es ein echter Tap war (horizontale Linie platzieren bzw. leere
  // Fläche antippen zum Abwählen) oder ein Wischen/Ziehen (dann nichts davon auslösen).
  const svgPointerDownRef = useRef(null);
  // WICHTIG: Horizontale Linie platzieren UND "leere Fläche antippen = abwählen" laufen jetzt
  // über pointerup statt über das 'click'-Event. Grund: seit touchstart auf dem Chart aus
  // Callout-Gründen (siehe onTouchStart weiter oben) preventDefault() aufruft, unterdrücken viele
  // mobile Browser danach die synthetische 'click'-Emulation komplett -- das 'click'-Event kam
  // auf dem Handy also gar nicht mehr zuverlässig an. pointerup feuert dagegen unabhängig davon
  // immer zuverlässig für Maus UND Touch.
  const handleSvgPointerUp = e => {
    clearTouchCrosshairState();
    const down = svgPointerDownRef.current;
    svgPointerDownRef.current = null;
    if (dragging) return;
    if (justInteractedRef.current) {
      justInteractedRef.current = false;
      return;
    }
    if (panDrag || pinchStateRef.current) return;
    if (!down) return;
    const pt = getLocalPoint(e);
    const dist = Math.hypot(pt.x - down.x, pt.y - down.y);
    if (dist > 10) return; // Wischen/Ziehen, kein Tap -- keine Aktion
    if (mode === 'horizontal') {
      const value = invYScale(pt.y);
      const newId = 'h' + Date.now() + Math.random();
      setHLines(prev => [...prev, {
        id: newId,
        value
      }]);
      setDrawHistory(h => [...h, {
        type: 'h',
        id: newId
      }]);
      setMode('pointer');
    } else if (mode === 'pointer') {
      setSelectedId(null); // Tap auf leere Fläche: Auswahl/Löschen-Button ausblenden
    }
    // mode 'trend': wird komplett über die eigene Zieh-Geste erledigt (siehe
    // handleSvgPointerDown + der zugehörige Effekt), hier bewusst keine Aktion.
  };

  // Entf/Backspace löscht die aktuell ausgewählte Zeichnung — wie in TradingView üblich.
  useEffect(() => {
    if (!selectedId) return;
    const onKeyDown = e => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const tag = e.target && e.target.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // nicht eingreifen, falls wer gerade tippt
      setHLines(prev => prev.filter(x => x.id !== selectedId));
      setTLines(prev => prev.filter(x => x.id !== selectedId));
      setDrawHistory(h => h.filter(x => x.id !== selectedId));
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  // Rückgängig: entfernt die zuletzt NEU GEZEICHNETE Linie (horizontal oder Trend), unabhängig
  // vom Typ -- ermittelt über drawHistory (siehe oben). Per Klick auf den Rückgängig-Button ODER
  // per Strg/Cmd+Z, wie in TradingView & Co. üblich.
  const handleUndo = () => {
    setDrawHistory(h => {
      if (!h.length) return h;
      const last = h[h.length - 1];
      if (last.type === 'h') {
        setHLines(prev => prev.filter(x => x.id !== last.id));
      } else {
        setTLines(prev => prev.filter(x => x.id !== last.id));
      }
      setSelectedId(id => id === last.id ? null : id);
      return h.slice(0, -1);
    });
  };
  useEffect(() => {
    if (!drawHistory.length) return;
    const onKeyDown = e => {
      if (!(e.key === 'z' || e.key === 'Z') || !(e.ctrlKey || e.metaKey)) return;
      const tag = e.target && e.target.tagName || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      handleUndo();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawHistory]);

  // Zwei-Finger-Pinch zum Zoomen: über native Touch-Events (nicht Pointer-Events) umgesetzt —
  // das ist der klassische, auf allen Mobil-Browsern zuverlässig unterstützte Weg für
  // Multi-Touch-Gesten. Läuft komplett unabhängig vom Ein-Finger-Verschieben unten (das
  // reagiert nur auf einen einzigen aktiven Kontaktpunkt).
  //
  // WICHTIG: React hängt Touch-Listener standardmäßig als "passive" ein — dadurch wird
  // preventDefault() darin stillschweigend IGNORIERT (bekannte React-Falle seit v17), und der
  // Browser macht sein eigenes natives Pinch-Zoom trotzdem. Deshalb werden die Listener hier
  // manuell mit { passive: false } direkt am DOM-Element registriert, nicht über JSX-Props.
  const pinchStateRef = useRef(null); // { startDist, startWidth, startIdx, midIdx }
  const pinchLatestRef = useRef(null); // { dist, midX } -- neuester Fingerstand, wird pro Frame gebündelt angewendet
  const pinchRafRef = useRef(null);
  const chartStateRef = useRef({});
  chartStateRef.current = {
    mode,
    isCandles,
    zoomEnabled,
    candleWidthPxEff,
    viewStartIdxEff,
    padding,
    CANDLE_W_MIN,
    CANDLE_W_MAX: CANDLE_W_MAX_EFF,
    N,
    innerW
  };
  const getTouchPoint = touch => {
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const cancelPinchRaf = () => {
      if (pinchRafRef.current != null) {
        cancelAnimationFrame(pinchRafRef.current);
        pinchRafRef.current = null;
      }
    };
    const onTouchStart = e => {
      activeTouchCountRef.current = e.touches.length;
      // Unterdrückt zuverlässig das native "Kopieren / Nachschlagen"-Kontextmenü bei längerem
      // Drücken (iOS/Android) -- touchAction:'none' auf dem SVG allein reicht dafür NICHT, das
      // steuert nur Scroll-/Zoom-Gesten, nicht das Auswahl-Kontextmenü. Bewusst UNBEDINGT ganz
      // oben, bevor der frühere return unten greift -- sonst blieb genau der Fall ungeschützt,
      // in dem es am ehesten auftritt: längeres Drücken beim Zeichnen einer Trendlinie
      // (mode 'trend'/'horizontal'), wo der Handler vorher sofort zurückkehrte, ohne
      // preventDefault() je aufzurufen.
      e.preventDefault();
      const s = chartStateRef.current;
      if (s.mode !== 'pointer' || !s.zoomEnabled) return;
      if (e.touches.length === 2) {
        e.preventDefault();
        setPanDrag(null); // Ein-Finger-Verschieben pausieren, solange gepincht wird
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        touchPendingRef.current = null;
        setCrosshairActive(false);
        setHover(null); // Crosshair ausblenden — sonst können zwei Finger zwei Positionen "melden" und es sieht aus wie zwei Preis-Labels/Linien
        setMousePixel(null);
        cancelPinchRaf();
        pinchLatestRef.current = null;
        const p1 = getTouchPoint(e.touches[0]);
        const p2 = getTouchPoint(e.touches[1]);
        const dist = Math.max(Math.hypot(p1.x - p2.x, p1.y - p2.y), 1);
        const midX = (p1.x + p2.x) / 2;
        const midIdx = s.viewStartIdxEff + (midX - s.padding.left) / s.candleWidthPxEff;
        pinchStateRef.current = {
          startDist: dist,
          startWidth: s.candleWidthPxEff,
          midIdx
        };
      }
    };
    // Zwischenschritte werden NICHT mehr sofort bei jedem einzelnen touchmove-Event in den State
    // geschrieben (auf manchen Geräten feuert das weit über 60x/Sekunde und lässt den Zoom
    // "flattern"/ruckeln), sondern nur der jeweils neueste Fingerabstand gemerkt und einmal pro
    // Animationsframe angewendet -- fühlt sich dadurch spürbar weicher an, ohne an Reaktions-
    // geschwindigkeit zu verlieren.
    const applyPinchFrame = () => {
      pinchRafRef.current = null;
      const latest = pinchLatestRef.current;
      const ps = pinchStateRef.current;
      if (!latest || !ps) return;
      const s = chartStateRef.current;
      const rawScaleFactor = latest.dist / ps.startDist; // Finger auseinander (dist wächst) -> größerer Faktor -> reinzoomen
      const scaleFactor = Math.pow(rawScaleFactor, 0.8); // Finger-Zoom soll der tatsächlichen Fingerbewegung nah folgen — nur ganz leicht gedämpft gegen Zittern
      const newWidth = Math.min(s.CANDLE_W_MAX, Math.max(s.CANDLE_W_MIN, ps.startWidth * scaleFactor));
      let newStart = ps.midIdx - (latest.midX - s.padding.left) / newWidth;
      const newVisibleCount = s.innerW / newWidth;
      newStart = Math.max(newStart, -3);
      newStart = Math.min(newStart, Math.max(-3, s.N - newVisibleCount * 0.3));
      userInteractedRef.current = true;
      setCandleWidthPx(newWidth);
      setViewStartIdx(newStart);
      setYZoomDomain(null);
    };
    const onTouchMove = e => {
      activeTouchCountRef.current = e.touches.length;
      if (e.touches.length === 2 && pinchStateRef.current) {
        e.preventDefault();
        const p1 = getTouchPoint(e.touches[0]);
        const p2 = getTouchPoint(e.touches[1]);
        const dist = Math.max(Math.hypot(p1.x - p2.x, p1.y - p2.y), 1);
        const midX = (p1.x + p2.x) / 2;
        pinchLatestRef.current = {
          dist,
          midX
        };
        if (pinchRafRef.current == null) pinchRafRef.current = requestAnimationFrame(applyPinchFrame);
      }
    };
    const onTouchEnd = e => {
      activeTouchCountRef.current = e.touches.length;
      if (e.touches.length < 2) {
        if (pinchStateRef.current) justInteractedRef.current = true;
        pinchStateRef.current = null;
        pinchLatestRef.current = null;
        cancelPinchRaf();
      }
    };
    el.addEventListener('touchstart', onTouchStart, {
      passive: false
    });
    el.addEventListener('touchmove', onTouchMove, {
      passive: false
    });
    el.addEventListener('touchend', onTouchEnd, {
      passive: false
    });
    el.addEventListener('touchcancel', onTouchEnd, {
      passive: false
    });
    return () => {
      cancelPinchRaf();
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, []);

  // Ziehen auf leerer Fläche (nicht auf einer Linie, die stoppt ihr eigenes pointerDown via
  // stopPropagation) verschiebt den sichtbaren Zeitausschnitt — wie bei TradingView & Co.
  // Reagiert nur auf einen einzelnen aktiven Kontaktpunkt; sobald ein zweiter Finger dazukommt,
  // übernehmen die Touch-Handler oben (Pinch-Zoom) und dieses Verschieben pausiert.
  const handleSvgPointerDown = e => {
    {
      const ptTap = getLocalPoint(e);
      svgPointerDownRef.current = {
        x: ptTap.x,
        y: ptTap.y
      };
    }
    if (mode === 'trend') {
      // Trendlinie als EINE durchgehende Zieh-Geste: Antippen/Drücken setzt sofort den fixen
      // Startpunkt, Ziehen (bei gehaltenem Finger/Maustaste) verlängert die Linie live (siehe
      // Effekt weiter unten mit global registrierten Listenern), Loslassen fixiert sie sofort --
      // kein zweiter Tap mehr nötig, und die frisch gezeichnete Linie bleibt danach NICHT
      // markiert/hervorgehoben.
      if (pinchStateRef.current || e.pointerType === 'touch' && activeTouchCountRef.current >= 2) return;
      const pt = getLocalPoint(e);
      const a = toAbs(pt);
      setSelectedId(null);
      setPendingStart({
        x1: a.x,
        y1: a.y,
        x2: a.x,
        y2: a.y
      });
      trendDrawPixelRef.current = {
        downX: pt.x,
        downY: pt.y,
        lastX: pt.x,
        lastY: pt.y
      };
      return;
    }
    if (mode !== 'pointer') return;
    if (pinchStateRef.current) return; // während des Pinchens nicht zusätzlich verschieben
    if (e.pointerType === 'touch' && activeTouchCountRef.current >= 2) return; // 2. Finger schon da (oder gerade dabei) -> das ist Pinch-Zoom, kein Ein-Finger-Verschieben/Halten
    const pt = getLocalPoint(e);

    // Linien-Charts (z.B. der Portfolio-Wert-Chart) unterstützen kein Verschieben/Zoomen --
    // deshalb muss hier NICHT zwischen "Wischen" und "Halten" unterschieden werden wie unten
    // bei den Kerzen-Charts. Ein einzelner Tap zeigt das Fadenkreuz (Wert + Datum) sofort,
    // ohne auf einen Long-Press zu warten -- das war der Bug: bisher griff die komplette
    // Touch-Fadenkreuz-Logik nur, wenn Zoom/Verschieben aktiv ist (Kerzen-Charts oder
    // allowZoom), wodurch ein Tap auf einen Chart ohne Zoom (z.B. Portfolio-Wert-Chart)
    // weiterhin sofort das Fadenkreuz zeigt statt auf Wischen/Long-Press zu warten.
    if (!zoomEnabled) {
      if (e.pointerType === 'touch') setCrosshairActive(true);
      updateHoverAt(pt);
      return;
    }
    if (e.pointerType === 'touch') {
      // Noch nicht sofort verschieben: erst abwarten, ob daraus eine Wischbewegung (-> Verschieben)
      // oder ein kurzes, ruhiges Halten (-> Fadenkreuz) wird.
      touchPendingRef.current = {
        x: pt.x,
        y: pt.y
      };
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        if (touchPendingRef.current) {
          setCrosshairActive(true);
          updateHoverAt(touchPendingRef.current);
          if (navigator.vibrate) {
            try {
              navigator.vibrate(10);
            } catch (err) {}
          }
        }
      }, 380);
      return;
    }
    userInteractedRef.current = true;
    setPanDrag({
      startPx: pt.x,
      startPy: pt.y,
      startIdx: viewStartIdxEff,
      startYLo: yLo,
      startYHi: yHi
    });
  };
  useEffect(() => {
    if (!panDrag) return;
    let moved = false;
    let rafId = null;
    let latestEvent = null;
    const applyPan = () => {
      rafId = null;
      const e = latestEvent;
      if (!e) return;
      const pt = getLocalPoint(e);
      const deltaPx = pt.x - panDrag.startPx;
      const deltaPy = pt.y - panDrag.startPy;
      if (Math.abs(deltaPx) > 3 || Math.abs(deltaPy) > 3) moved = true;

      // Beide Achsen gleichzeitig und flüssig folgen der tatsächlichen Fingerbewegung — kein
      // Feststellen mehr auf eine Richtung, man kann mitten in der Geste die Richtung wechseln,
      // ohne loszulassen. (Das alte "Feststecken" kam von einer Divisions-Absicherung, die
      // inzwischen behoben ist — nicht vom gleichzeitigen Zulassen beider Achsen.)
      // Verschiebung jetzt in Kerzen-Indizes statt Zeit — bei fester Kerzenbreite entspricht das
      // exakt der gleichen Anzahl Pixel pro Kerze, egal wo im Chart man gerade ist.
      let newStart = panDrag.startIdx - deltaPx / candleWidthPxEff;
      // Nur nach LINKS (vor den ersten Datenpunkt) leicht begrenzt — dort gibt es keine Daten.
      // Nach RECHTS bewusst KEINE Grenze: man soll beliebig weit in die "Zukunft" scrollen
      // können (z.B. um eine horizontale Linie dort weiterzuverfolgen oder einfach Platz zu haben).
      newStart = Math.max(newStart, -3);
      setViewStartIdx(newStart);
      if (isLogScale) {
        const startLoLog = Math.log(Math.max(panDrag.startYLo, 1e-9));
        const startHiLog = Math.log(Math.max(panDrag.startYHi, Math.max(panDrag.startYLo, 1e-9) * 1.0001));
        const deltaLog = deltaPy / innerH * (startHiLog - startLoLog);
        setYZoomDomain({
          yLo: Math.exp(startLoLog + deltaLog),
          yHi: Math.exp(startHiLog + deltaLog)
        });
      } else {
        const ySpan = panDrag.startYHi - panDrag.startYLo;
        const deltaPrice = deltaPy / innerH * ySpan;
        if (Number.isFinite(deltaPrice)) {
          setYZoomDomain({
            yLo: panDrag.startYLo + deltaPrice,
            yHi: panDrag.startYHi + deltaPrice
          });
        }
      }
    };
    const onMove = e => {
      latestEvent = e;
      if (rafId == null) rafId = requestAnimationFrame(applyPan);
    };
    const onUp = e => {
      if (rafId != null) cancelAnimationFrame(rafId);
      setPanDrag(null);
      // Echtes Ziehen (nicht nur ein kurzer Klick) soll das nachfolgende Klick-Event nicht als
      // "leere Fläche antippen -> Auswahl aufheben" behandeln, um Ruckler zu vermeiden.
      if (moved) justInteractedRef.current = true;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      if (rafId != null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, [panDrag, innerW, innerH, candleWidthPxEff]);

  // Trendlinie wird über eine durchgehende Zieh-Geste gesetzt (siehe handleSvgPointerDown und
  // der zugehörige Effekt weiter unten). Escape bricht eine gerade laufende Zieh-Geste ab.
  useEffect(() => {
    if (!pendingStart || mode !== 'trend') return;
    const onKeyDown = e => {
      if (e.key === 'Escape') {
        setPendingStart(null);
        setMode('pointer');
        trendDrawPixelRef.current = null;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingStart, mode]);

  // Globale Listener während des ZIEHENS einer NEUEN Trendlinie -- registriert (wie beim
  // Verschieben bestehender Zeichnungen unten) direkt am window, nicht nur am SVG-Element, damit
  // ein Finger, der beim Ziehen kurz aus dem Chart-Bereich rutscht, die Geste nicht abbricht.
  // MIN_DRAG_PX verhindert, dass ein reiner Tap (ohne echtes Ziehen) eine kaum sichtbare
  // Mini-Linie erzeugt -- in dem Fall wird der Start einfach verworfen.
  useEffect(() => {
    if (!pendingStart || mode !== 'trend') return;
    const MIN_DRAG_PX = 6;
    const onMove = e => {
      const pt = getLocalPoint(e);
      trendDrawPixelRef.current = trendDrawPixelRef.current ? {
        ...trendDrawPixelRef.current,
        lastX: pt.x,
        lastY: pt.y
      } : null;
      const a = toAbs(pt);
      setPendingStart(prev => prev ? {
        ...prev,
        x2: a.x,
        y2: a.y
      } : prev);
    };
    const onUp = () => {
      const px = trendDrawPixelRef.current;
      const dragDist = px ? Math.hypot(px.lastX - px.downX, px.lastY - px.downY) : 0;
      setPendingStart(prev => {
        if (prev && dragDist >= MIN_DRAG_PX) {
          const newId = 't' + Date.now() + Math.random();
          setTLines(tl => [...tl, {
            id: newId,
            x1: prev.x1,
            y1: prev.y1,
            x2: prev.x2,
            y2: prev.y2
          }]);
          setDrawHistory(h => [...h, {
            type: 't',
            id: newId
          }]);
        }
        return null;
      });
      setSelectedId(null); // frisch gezeichnete Linie bleibt NICHT markiert/hervorgehoben
      setMode('pointer');
      trendDrawPixelRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, [pendingStart, mode]);

  // Globale Listener während des Ziehens einer Linie
  useEffect(() => {
    if (!dragging) return;
    const onMove = e => {
      const pt = getLocalPoint(e);
      if (dragging.type === 'h') {
        const value = invYScale(pt.y);
        setHLines(prev => prev.map(l => l.id === dragging.id ? {
          ...l,
          value
        } : l));
      } else if (dragging.type === 'tpoint') {
        const a = toAbs(pt);
        setTLines(prev => prev.map(l => {
          if (l.id !== dragging.id) return l;
          return dragging.which === 1 ? {
            ...l,
            x1: a.x,
            y1: a.y
          } : {
            ...l,
            x2: a.x,
            y2: a.y
          };
        }));
      } else if (dragging.type === 'tline') {
        const a = toAbs(pt);
        const dx = a.x - dragging.startAbs.x;
        const dy = a.y - dragging.startAbs.y;
        setTLines(prev => prev.map(l => l.id === dragging.id ? {
          ...l,
          x1: dragging.orig.x1 + dx,
          y1: dragging.orig.y1 + dy,
          x2: dragging.orig.x2 + dx,
          y2: dragging.orig.y2 + dy
        } : l));
      }
    };
    const onUp = () => setDragging(null);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('touchend', onUp);
    window.addEventListener('touchcancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('touchend', onUp);
      window.removeEventListener('touchcancel', onUp);
    };
  }, [dragging]);
  // Zusätzlich zu lineHoverId (das über pointerenter/-leave gesetzt wird, was auf Touch-Geräten
  // beim Ziehen nicht immer zuverlässig feuert) hier direkt geometrisch prüfen, ob die aktuelle
  // Zeiger-/Fingerposition nahe genug an einer gezeichneten Linie liegt -- funktioniert dadurch
  // gleichermaßen mit Maus UND Finger und blendet das Fadenkreuz zuverlässig aus, sobald man
  // eine Linie markieren möchte.
  const isNearDrawnLine = (() => {
    if (!mousePixel || !allowDrawing) return false;
    const HIT = 11; // halbe Trefferbreite der unsichtbaren Linien-Hitbox (strokeWidth 22)
    for (const l of hLines) {
      if (Math.abs(mousePixel.y - yScale(l.value)) <= HIT) return true;
    }
    for (const l of tLines) {
      const p1 = fromAbs({
        x: l.x1,
        y: l.y1
      });
      const p2 = fromAbs({
        x: l.x2,
        y: l.y2
      });
      const dx = p2.x - p1.x,
        dy = p2.y - p1.y;
      const lenSq = dx * dx + dy * dy;
      let t = lenSq > 0 ? ((mousePixel.x - p1.x) * dx + (mousePixel.y - p1.y) * dy) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const closestX = p1.x + t * dx,
        closestY = p1.y + t * dy;
      if (Math.hypot(mousePixel.x - closestX, mousePixel.y - closestY) <= HIT) return true;
    }
    return false;
  })();
  const showCrosshair = hover && mode === 'pointer' && !dragging && !panDrag && !lineHoverId && !isNearDrawnLine;
  return /*#__PURE__*/React.createElement("div", {
    ref: containerRef,
    style: {
      position: 'relative',
      width: '100%',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none'
    },
    onContextMenu: e => e.preventDefault()
  }, isCandles && /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#FF3B30',
      color: '#fff',
      fontFamily: 'Consolas, monospace',
      fontSize: 13,
      fontWeight: 700,
      padding: '6px 10px',
      borderRadius: 6,
      marginBottom: 8,
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px 14px'
    }
  }, /*#__PURE__*/React.createElement("span", null, "BUILD v5-fix"), /*#__PURE__*/React.createElement("span", null, "Kerzen N=", N), /*#__PURE__*/React.createElement("span", null, "Breite=", candleWidthPxEff.toFixed(1), "px"), /*#__PURE__*/React.createElement("span", null, "Slots=", visibleCount.toFixed(1)), /*#__PURE__*/React.createElement("span", null, "Fuellung=", Math.min(100, Math.round(100 * N / Math.max(visibleCount, 0.001))), "%"), /*#__PURE__*/React.createElement("span", null, "Zoom=", candleWidthPx != null || viewStartIdx != null ? 'manuell' : 'auto'), /*#__PURE__*/React.createElement("span", null, "echteInteraktion=", userInteractedRef.current ? 'ja' : 'NEIN'), /*#__PURE__*/React.createElement("span", null, "widthOK=", widthIsSane ? 'ja' : 'NEIN'), /*#__PURE__*/React.createElement("span", null, "dataOK=", dataIsSane ? 'ja' : 'NEIN'), /*#__PURE__*/React.createElement("span", null, "overlap=", overlapCount.toFixed(1))), allowDrawing && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
      paddingLeft: 2,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("button", {
    title: t('toolSelect', lang),
    onClick: () => {
      setMode('pointer');
      setPendingStart(null);
    },
    style: toolBtnStyle(mode === 'pointer')
  }, /*#__PURE__*/React.createElement(IconPointer, {
    size: 14
  })), /*#__PURE__*/React.createElement("div", {
    ref: lineToolMenuRef,
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    title: t('toolLineMenu', lang),
    onClick: () => setLineToolMenuOpen(v => !v),
    style: {
      ...toolBtnStyle(mode === 'horizontal' || mode === 'trend'),
      width: 'auto',
      padding: '0 6px',
      gap: 2
    }
  }, /*#__PURE__*/React.createElement(mode === 'trend' ? IconTrendLine : IconHLine, {
    size: 14
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      opacity: 0.75,
      marginLeft: 1
    }
  }, "▾")), lineToolMenuOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '110%',
      left: 0,
      zIndex: 30,
      background: '#0C1F21',
      border: '1px solid #1A3436',
      borderRadius: 8,
      boxShadow: '0 8px 20px -8px rgba(0,0,0,0.6)',
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 168
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setMode('horizontal');
      setPendingStart(null);
      setSelectedId(null);
      setLineToolMenuOpen(false);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      background: mode === 'horizontal' ? 'rgba(0,222,225,0.12)' : 'transparent',
      border: 'none',
      borderRadius: 6,
      color: mode === 'horizontal' ? '#00DEE1' : '#D7E7E8',
      fontSize: 12,
      cursor: 'pointer',
      textAlign: 'left',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement(IconHLine, {
    size: 14
  }), t('toolHLine', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setMode('trend');
      setPendingStart(null);
      setSelectedId(null);
      setLineToolMenuOpen(false);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      padding: '6px 8px',
      background: mode === 'trend' ? 'rgba(0,222,225,0.12)' : 'transparent',
      border: 'none',
      borderRadius: 6,
      color: mode === 'trend' ? '#00DEE1' : '#D7E7E8',
      fontSize: 12,
      cursor: 'pointer',
      textAlign: 'left',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement(IconTrendLine, {
    size: 14
  }), t('toolTrend', lang)))), (hLines.length > 0 || tLines.length > 0) && /*#__PURE__*/React.createElement("button", {
    title: selectedId ? t('deleteSelectedDrawing', lang) : t('tapDrawingFirst', lang),
    onClick: () => {
      if (selectedId) {
        setHLines(prev => prev.filter(x => x.id !== selectedId));
        setTLines(prev => prev.filter(x => x.id !== selectedId));
        setDrawHistory(h => h.filter(x => x.id !== selectedId));
        setSelectedId(null);
      }
    },
    style: {
      ...toolBtnStyle(false),
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      width: selectedId ? 'auto' : 30,
      padding: selectedId ? '0 10px 0 8px' : 0,
      background: selectedId ? 'rgba(240,120,120,0.14)' : toolBtnStyle(false).background,
      border: selectedId ? '1px solid rgba(240,120,120,0.4)' : toolBtnStyle(false).border,
      color: selectedId ? '#F0A0A0' : toolBtnStyle(false).color,
      opacity: selectedId ? 1 : 0.4,
      cursor: selectedId ? 'pointer' : 'default'
    }
  }, /*#__PURE__*/React.createElement(IconTrash, {
    size: 14
  }), selectedId && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11.5,
      fontWeight: 700,
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap'
    }
  }, t('deleteWord', lang))), /*#__PURE__*/React.createElement("button", {
    title: t('undoDrawing', lang),
    onClick: handleUndo,
    disabled: !drawHistory.length,
    style: {
      ...toolBtnStyle(false),
      opacity: drawHistory.length ? 1 : 0.35,
      cursor: drawHistory.length ? 'pointer' : 'default'
    }
  }, /*#__PURE__*/React.createElement(IconUndo, {
    size: 14
  })), mode === 'horizontal' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#7C9698',
      fontSize: 11,
      marginLeft: 4
    }
  }, t('tapChartPlaceLine', lang)), mode === 'trend' && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#7C9698',
      fontSize: 11,
      marginLeft: 4
    }
  }, t('tapStartPoint', lang))), /*#__PURE__*/React.createElement("svg", {
    ref: svgRef,
    width: width,
    height: height,
    onPointerMove: handleSvgMouseMove,
    onPointerLeave: () => {
      setHover(null);
      setMousePixel(null);
    },
    onPointerDown: handleSvgPointerDown,
    onPointerUp: handleSvgPointerUp,
    onWheel: handleWheel,
    onDoubleClick: () => {
      setCandleWidthPx(null);
      setViewStartIdx(null);
      setYZoomDomain(null);
    },
    style: {
      display: 'block',
      cursor: panDrag ? 'grabbing' : 'default',
      touchAction: 'none',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("clipPath", {
    id: `chartPlotClip-${storageKeyPrefix}`
  }, /*#__PURE__*/React.createElement("rect", {
    x: padding.left,
    y: padding.top,
    width: innerW,
    height: innerH
  })), showAreaFill && /*#__PURE__*/React.createElement("linearGradient", {
    id: `tpAreaGrad-${storageKeyPrefix}`,
    gradientUnits: "userSpaceOnUse",
    x1: "0",
    y1: padding.top,
    x2: "0",
    y2: padding.top + innerH
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#00DEE1",
    stopOpacity: "0.35"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#00DEE1",
    stopOpacity: "0"
  }))), showAxis && yTickVals.map((v, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: padding.left,
    x2: width - padding.right,
    y1: yScale(v),
    y2: yScale(v),
    stroke: "#102224",
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement("text", {
    x: padding.left - 10,
    y: yScale(v) + 4,
    textAnchor: "end",
    fontSize: "11",
    fill: "#7C9698",
    fontFamily: "Inter, sans-serif"
  }, formatValueLabel(v)))), showAxis && xTickVals.map((v, i) => /*#__PURE__*/React.createElement("text", {
    key: i,
    x: xScale(v),
    y: height - 8,
    textAnchor: "middle",
    fontSize: "11",
    fill: "#7C9698",
    fontFamily: "Inter, sans-serif"
  }, dateFormatter(v, lang))), isCandles ? /*#__PURE__*/React.createElement("g", {
    pointerEvents: "none",
    clipPath: `url(#chartPlotClip-${storageKeyPrefix})`
  }, candles.map((c, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: c.x,
    x2: c.x,
    y1: c.wickTop,
    y2: c.wickBottom,
    stroke: c.up ? '#FFFFFF' : '#4E6668',
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("rect", {
    x: c.x - candleBodyW / 2,
    y: c.bodyTop,
    width: candleBodyW,
    height: Math.max(1, c.bodyBottom - c.bodyTop),
    fill: c.up ? '#FFFFFF' : '#4E6668'
  }))), showMA200 && ma200Path && /*#__PURE__*/React.createElement("path", {
    d: ma200Path,
    fill: "none",
    stroke: "#C9A961",
    strokeWidth: "1.3",
    opacity: "0.85"
  }), showBB && bbUpperPath && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("path", {
    d: bbUpperPath,
    fill: "none",
    stroke: "#6FA8DC",
    strokeWidth: "1",
    opacity: "0.7"
  }), /*#__PURE__*/React.createElement("path", {
    d: bbLowerPath,
    fill: "none",
    stroke: "#6FA8DC",
    strokeWidth: "1",
    opacity: "0.7"
  }), /*#__PURE__*/React.createElement("path", {
    d: bbMidPath,
    fill: "none",
    stroke: "#6FA8DC",
    strokeWidth: "1",
    strokeDasharray: "3 3",
    opacity: "0.5"
  }))) : /*#__PURE__*/React.createElement("g", {
    clipPath: `url(#chartPlotClip-${storageKeyPrefix})`
  }, !isCandles && allowVolume && showVolume && volSeriesRender.map((d, i) => /*#__PURE__*/React.createElement("rect", {
    key: `vol-${i}`,
    x: xScale(d.date) - volBarW / 2,
    y: volOverlayBottom - volOverlayBarH(d.volume),
    width: volBarW,
    height: volOverlayBarH(d.volume),
    fill: "#00DEE1",
    opacity: "0.16"
  })), showAreaFill && /*#__PURE__*/React.createElement("path", {
    d: smoothAreaPath,
    fill: `url(#tpAreaGrad-${storageKeyPrefix})`,
    stroke: "none",
    pointerEvents: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: smoothLinePath,
    fill: "none",
    stroke: "#00DEE1",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    pointerEvents: "none"
  }), allowMA200 && showMA200 && ma200Path && /*#__PURE__*/React.createElement("path", {
    d: ma200Path,
    fill: "none",
    stroke: "#C9A961",
    strokeWidth: "1.3",
    opacity: "0.85",
    pointerEvents: "none"
  })), allowDrawing && hLines.map(l => {
    const y = yScale(l.value);
    const selected = selectedId === l.id;
    const hovered = lineHoverId === l.id;
    return /*#__PURE__*/React.createElement("g", {
      key: l.id
    }, /*#__PURE__*/React.createElement("line", {
      x1: padding.left,
      x2: padding.left + innerW,
      y1: y,
      y2: y,
      stroke: "transparent",
      strokeWidth: "22",
      style: {
        cursor: 'pointer',
        touchAction: 'none',
        pointerEvents: mode === 'pointer' ? 'auto' : 'none'
      },
      onPointerDown: e => {
        e.stopPropagation();
        justInteractedRef.current = true;
        setSelectedId(l.id);
        setDragging({
          type: 'h',
          id: l.id
        });
      },
      onPointerEnter: () => setLineHoverId(l.id),
      onPointerLeave: () => setLineHoverId(id => id === l.id ? null : id)
    }), /*#__PURE__*/React.createElement("line", {
      x1: padding.left,
      x2: padding.left + innerW,
      y1: y,
      y2: y,
      stroke: "#FFFFFF",
      strokeWidth: selected || hovered ? 2 : 1.25,
      pointerEvents: "none",
      opacity: selected || hovered ? 1 : 0.85
    }), (() => {
      const label = formatValueLabel(l.value);
      const maxW = padding.left - 8; // bleibt strikt im Achsen-Rand, nie im Datenbereich
      const boxW = Math.min(label.length * 5.8 + 8, maxW);
      const boxH = 16;
      const bx = Math.max(2, padding.left - boxW - 4);
      const by = Math.min(height - padding.bottom - boxH, Math.max(padding.top, y - boxH / 2));
      return /*#__PURE__*/React.createElement("g", {
        pointerEvents: "none"
      }, /*#__PURE__*/React.createElement("rect", {
        x: bx,
        y: by,
        width: boxW,
        height: boxH,
        rx: 3,
        fill: selected ? '#FFFFFF' : '#000000',
        stroke: selected ? '#FFFFFF' : '#2A5254',
        strokeWidth: "1"
      }), /*#__PURE__*/React.createElement("text", {
        x: bx + boxW / 2,
        y: by + boxH / 2 + 3.5,
        textAnchor: "middle",
        fontSize: "9",
        fill: selected ? '#0A0A0A' : '#F5F5F5',
        fontFamily: "Inter, sans-serif"
      }, label));
    })());
  }), allowDrawing && tLines.map(l => {
    const p1 = fromAbs({
      x: l.x1,
      y: l.y1
    });
    const p2 = fromAbs({
      x: l.x2,
      y: l.y2
    });
    const selected = selectedId === l.id;
    const hovered = lineHoverId === l.id;
    return /*#__PURE__*/React.createElement("g", {
      key: l.id
    }, /*#__PURE__*/React.createElement("line", {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      stroke: "transparent",
      strokeWidth: "22",
      style: {
        cursor: 'pointer',
        touchAction: 'none',
        pointerEvents: mode === 'pointer' ? 'auto' : 'none'
      },
      onPointerDown: e => {
        e.stopPropagation();
        justInteractedRef.current = true;
        setSelectedId(l.id);
        const pt = getLocalPoint(e);
        const a = toAbs(pt);
        setDragging({
          type: 'tline',
          id: l.id,
          startAbs: a,
          orig: {
            x1: l.x1,
            y1: l.y1,
            x2: l.x2,
            y2: l.y2
          }
        });
      },
      onPointerEnter: () => setLineHoverId(l.id),
      onPointerLeave: () => setLineHoverId(id => id === l.id ? null : id)
    }), /*#__PURE__*/React.createElement("line", {
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
      stroke: "#FFFFFF",
      strokeWidth: selected || hovered ? 2 : 1.25,
      pointerEvents: "none"
    }), selected && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
      cx: p1.x,
      cy: p1.y,
      r: "20",
      fill: "transparent",
      style: {
        cursor: 'grab',
        touchAction: 'none',
        pointerEvents: mode === 'pointer' ? 'auto' : 'none'
      },
      onPointerDown: e => {
        e.stopPropagation();
        justInteractedRef.current = true;
        setSelectedId(l.id);
        setDragging({
          type: 'tpoint',
          id: l.id,
          which: 1
        });
      }
    }), /*#__PURE__*/React.createElement("circle", {
      cx: p1.x,
      cy: p1.y,
      r: "5",
      fill: "#0A0A0A",
      stroke: "#FFFFFF",
      strokeWidth: "1.5",
      pointerEvents: "none"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: p2.x,
      cy: p2.y,
      r: "20",
      fill: "transparent",
      style: {
        cursor: 'grab',
        touchAction: 'none',
        pointerEvents: mode === 'pointer' ? 'auto' : 'none'
      },
      onPointerDown: e => {
        e.stopPropagation();
        justInteractedRef.current = true;
        setSelectedId(l.id);
        setDragging({
          type: 'tpoint',
          id: l.id,
          which: 2
        });
      }
    }), /*#__PURE__*/React.createElement("circle", {
      cx: p2.x,
      cy: p2.y,
      r: "5",
      fill: "#0A0A0A",
      stroke: "#FFFFFF",
      strokeWidth: "1.5",
      pointerEvents: "none"
    })));
  }), mode === 'trend' && pendingStart && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("line", {
    x1: fromAbs({
      x: pendingStart.x1,
      y: pendingStart.y1
    }).x,
    y1: fromAbs({
      x: pendingStart.x1,
      y: pendingStart.y1
    }).y,
    x2: fromAbs({
      x: pendingStart.x2,
      y: pendingStart.y2
    }).x,
    y2: fromAbs({
      x: pendingStart.x2,
      y: pendingStart.y2
    }).y,
    stroke: "#FFFFFF",
    strokeWidth: "1.5",
    strokeDasharray: "4 3",
    pointerEvents: "none"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: fromAbs({
      x: pendingStart.x1,
      y: pendingStart.y1
    }).x,
    cy: fromAbs({
      x: pendingStart.x1,
      y: pendingStart.y1
    }).y,
    r: "4",
    fill: "#FFFFFF",
    pointerEvents: "none"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: fromAbs({
      x: pendingStart.x2,
      y: pendingStart.y2
    }).x,
    cy: fromAbs({
      x: pendingStart.x2,
      y: pendingStart.y2
    }).y,
    r: "4",
    fill: "#FFFFFF",
    pointerEvents: "none"
  })), isCandles && data.length > 0 && (() => {
    const lastPrice = data[data.length - 1].value;
    const ly = yScale(lastPrice);
    if (ly < padding.top - 20 || ly > padding.top + innerH + 20) return null; // weit außerhalb der Ansicht: nicht einblenden
    const label = formatValueLabel(lastPrice);
    const maxW = padding.left - 8;
    const boxW = Math.min(label.length * 5.8 + 8, maxW);
    const boxH = 16;
    const by = Math.min(height - padding.bottom - boxH, Math.max(padding.top, ly - boxH / 2));
    return /*#__PURE__*/React.createElement("g", {
      pointerEvents: "none"
    }, /*#__PURE__*/React.createElement("line", {
      x1: padding.left,
      x2: padding.left + innerW,
      y1: ly,
      y2: ly,
      stroke: "#A0BABC",
      strokeWidth: "1",
      strokeDasharray: "4 4",
      opacity: "0.5"
    }), /*#__PURE__*/React.createElement("rect", {
      x: 2,
      y: by,
      width: boxW,
      height: boxH,
      rx: 3,
      fill: "#0E2224",
      stroke: "#00DEE1",
      strokeWidth: "1",
      opacity: "0.95"
    }), /*#__PURE__*/React.createElement("text", {
      x: 2 + boxW / 2,
      y: by + boxH / 2 + 3.5,
      textAnchor: "middle",
      fontSize: "9",
      fontWeight: "600",
      fill: "#00DEE1",
      fontFamily: "Inter, sans-serif"
    }, label));
  })(), showCrosshair && /*#__PURE__*/React.createElement("g", {
    pointerEvents: "none"
  }, /*#__PURE__*/React.createElement("line", {
    x1: xScale(hover.date),
    x2: xScale(hover.date),
    y1: padding.top,
    y2: padding.top + innerH,
    stroke: "#2A5254",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("line", {
    x1: padding.left,
    x2: padding.left + innerW,
    y1: yScale(hover.value),
    y2: yScale(hover.value),
    stroke: "#2A5254",
    strokeWidth: "1"
  }), showHoverPriceLabel && (() => {
    const label = formatValueLabel(hover.value);
    const maxW = Math.max(56, padding.left - 8);
    const boxW = Math.min(label.length * 5.8 + 8, maxW);
    const boxH = 16;
    const by = Math.min(height - padding.bottom - boxH, Math.max(padding.top, yScale(hover.value) - boxH / 2));
    return /*#__PURE__*/React.createElement("g", {
      pointerEvents: "none"
    }, /*#__PURE__*/React.createElement("rect", {
      x: 2,
      y: by,
      width: boxW,
      height: boxH,
      rx: 3,
      fill: "#00DEE1"
    }), /*#__PURE__*/React.createElement("text", {
      x: 2 + boxW / 2,
      y: by + boxH / 2 + 3.5,
      textAnchor: "middle",
      fontSize: "9",
      fill: "#0A0A0A",
      fontFamily: "Inter, sans-serif"
    }, label));
  })(), /*#__PURE__*/React.createElement("circle", {
    cx: xScale(hover.date),
    cy: yScale(hover.value),
    r: "4",
    fill: "#00DEE1",
    stroke: "#000000",
    strokeWidth: "2"
  }), (() => {
    const dLabel = dateFormatter(hover.date, lang);
    const boxW = dLabel.length * 5.8 + 10;
    const boxH = 16;
    const bx = Math.min(padding.left + innerW - boxW, Math.max(padding.left, xScale(hover.date) - boxW / 2));
    const by = height - padding.bottom + 2;
    return /*#__PURE__*/React.createElement("g", {
      pointerEvents: "none"
    }, /*#__PURE__*/React.createElement("rect", {
      x: bx,
      y: by,
      width: boxW,
      height: boxH,
      rx: 3,
      fill: "#00DEE1"
    }), /*#__PURE__*/React.createElement("text", {
      x: bx + boxW / 2,
      y: by + boxH / 2 + 3.5,
      textAnchor: "middle",
      fontSize: "9",
      fill: "#0A0A0A",
      fontFamily: "Inter, sans-serif"
    }, dLabel));
  })())), zoomEnabled && isZoomed && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    title: t('resetZoom', lang),
    onClick: () => {
      setCandleWidthPx(null);
      setViewStartIdx(null);
      setYZoomDomain(null);
      userInteractedRef.current = false;
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 22,
      height: 22,
      background: 'transparent',
      color: '#7C9698',
      border: '1px solid #1A3436',
      borderRadius: '50%',
      padding: 0,
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(IconZoomOut, {
    size: 11
  }))), (isCandles || allowMA200 || zoomEnabled) && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginBottom: 2,
      paddingLeft: 2,
      flexWrap: 'wrap'
    }
  }, (isCandles || allowMA200) && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowMA200(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 9.5,
      color: showMA200 ? '#C9A961' : '#4C6062',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 10,
      height: 2,
      background: showMA200 ? '#C9A961' : '#4C6062'
    }
  }), " 200 Day Line"), isCandles && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowBB(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      fontSize: 9.5,
      color: showBB ? '#6FA8DC' : '#4C6062',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      width: 10,
      height: 2,
      background: showBB ? '#6FA8DC' : '#4C6062'
    }
  }), " Bollinger"), (isCandles || allowRSI) && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowRSI(v => !v),
    style: {
      fontSize: 9.5,
      color: showRSI ? '#7C9698' : '#4C6062',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0
    }
  }, "RSI (14)"), (isCandles || allowVolume) && /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowVolume(v => !v),
    style: {
      fontSize: 9.5,
      color: showVolume ? '#7C9698' : '#4C6062',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0
    }
  }, t('volumeWord', lang)), zoomEnabled && /*#__PURE__*/React.createElement("button", {
    onClick: () => setLogScale(v => !v),
    title: t('logScale', lang),
    style: {
      fontSize: 9.5,
      color: logScale ? '#7C9698' : '#4C6062',
      background: 'transparent',
      border: 'none',
      cursor: 'pointer',
      padding: 0
    }
  }, t('logScale', lang))), (isCandles || allowRSI) && showRSI && /*#__PURE__*/React.createElement("svg", {
    width: width,
    height: RSI_HEIGHT,
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("rect", {
    x: padding.left,
    y: 0,
    width: innerW,
    height: Math.max(0, rsiYScale(70)),
    fill: "rgba(240,160,160,0.07)"
  }), /*#__PURE__*/React.createElement("rect", {
    x: padding.left,
    y: rsiYScale(30),
    width: innerW,
    height: Math.max(0, RSI_HEIGHT - rsiYScale(30)),
    fill: "rgba(143,224,172,0.07)"
  }), /*#__PURE__*/React.createElement("line", {
    x1: padding.left,
    x2: padding.left + innerW,
    y1: rsiYScale(70),
    y2: rsiYScale(70),
    stroke: "#1A3436",
    strokeDasharray: "3 3",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("line", {
    x1: padding.left,
    x2: padding.left + innerW,
    y1: rsiYScale(30),
    y2: rsiYScale(30),
    stroke: "#1A3436",
    strokeDasharray: "3 3",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("text", {
    x: padding.left - 10,
    y: rsiYScale(70) + 3,
    textAnchor: "end",
    fontSize: "8.5",
    fill: "#5C7274",
    fontFamily: "Inter, sans-serif"
  }, "70"), /*#__PURE__*/React.createElement("text", {
    x: padding.left - 10,
    y: rsiYScale(30) + 3,
    textAnchor: "end",
    fontSize: "8.5",
    fill: "#5C7274",
    fontFamily: "Inter, sans-serif"
  }, "30"), rsiPath && /*#__PURE__*/React.createElement("path", {
    d: rsiPath,
    fill: "none",
    stroke: "#7C9698",
    strokeWidth: "1.3"
  }), showCrosshair && rsiSeries.length > 0 && /*#__PURE__*/React.createElement("line", {
    x1: xScale(hover.date),
    x2: xScale(hover.date),
    y1: 0,
    y2: RSI_HEIGHT,
    stroke: "#2A5254",
    strokeWidth: "1"
  })), isCandles && showVolume && /*#__PURE__*/React.createElement("svg", {
    width: width,
    height: VOLUME_HEIGHT,
    style: {
      display: 'block',
      marginTop: 4
    }
  }, volSeriesRender.map((d, i) => {
    // Kerzen: Vergleich mit dem eigenen Open (intra-Kerze). Linien-Charts ohne OHLC: Vergleich
    // mit dem vorherigen Punkt (typische Definition für Volumen-Einfärbung auf reinen
    // Close-Preis-Reihen), erster Balken mangels Vorgänger neutral als "up".
    const up = d.open != null ? d.value >= d.open : i > 0 ? d.value >= volSeriesRender[i - 1].value : true;
    const barH = Math.max(1, VOLUME_HEIGHT - volYScale(d.volume));
    return /*#__PURE__*/React.createElement("rect", {
      key: i,
      x: xScale(d.date) - volBarW / 2,
      y: VOLUME_HEIGHT - barH,
      width: volBarW,
      height: barH,
      fill: up ? '#FFFFFF' : '#4E6668',
      opacity: "0.45"
    });
  }), showCrosshair && volSeriesRender.length > 0 && /*#__PURE__*/React.createElement("line", {
    x1: xScale(hover.date),
    x2: xScale(hover.date),
    y1: 0,
    y2: VOLUME_HEIGHT,
    stroke: "#2A5254",
    strokeWidth: "1"
  }))));
}

// Kleine, nicht-interaktive Verlaufslinie für den Preis der letzten 24 Stunden -- im selben
// Look wie der große Portfolio-Chart (Teal-Linie #00DEE1 + Gradient-Flächenfüllung darunter,
// siehe PortfolioChartInner). Füllt den leeren Platz neben dem Preis auf dem PC-Bildschirm
// (siehe .tp-price-daily-chart).
function MiniPriceSparkline({
  data,
  gradientId
}) {
  if (!data || data.length < 2) return null;
  const width = 120;
  const height = 40;
  const values = data.map(d => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const range = maxV - minV || 1;
  const xScale = i => data.length > 1 ? i / (data.length - 1) * width : width / 2;
  const yScale = v => 3 + (height - 6) - (v - minV) / range * (height - 6);
  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i).toFixed(1)} ${yScale(d.value).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${xScale(data.length - 1).toFixed(1)} ${height} L ${xScale(0).toFixed(1)} ${height} Z`;
  const gid = gradientId || 'tpMiniSpark';
  const maskId = `${gid}-fade`;
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    style: {
      width: '100%',
      height: '100%',
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: gid,
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#00DEE1",
    stopOpacity: "0.35"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#00DEE1",
    stopOpacity: "0"
  })), /*#__PURE__*/React.createElement("linearGradient", {
    id: maskId,
    x1: "0",
    y1: "0",
    x2: "1",
    y2: "0"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#FFFFFF",
    stopOpacity: "0"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "12%",
    stopColor: "#FFFFFF",
    stopOpacity: "1"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "88%",
    stopColor: "#FFFFFF",
    stopOpacity: "1"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#FFFFFF",
    stopOpacity: "0"
  })), /*#__PURE__*/React.createElement("mask", {
    id: `${maskId}-mask`,
    maskUnits: "userSpaceOnUse",
    x: "0",
    y: "0",
    width: width,
    height: height
  }, /*#__PURE__*/React.createElement("rect", {
    x: "0",
    y: "0",
    width: width,
    height: height,
    fill: `url(#${maskId})`
  }))), /*#__PURE__*/React.createElement("g", {
    mask: `url(#${maskId}-mask)`
  }, /*#__PURE__*/React.createElement("path", {
    d: areaPath,
    fill: `url(#${gid})`,
    stroke: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: linePath,
    fill: "none",
    stroke: "#00DEE1",
    strokeWidth: "1.6",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  })));
}

// Formular zum Erfassen/Bearbeiten eines einzelnen RUNE-Kaufs. Erlaubt wahlweise Eingabe von
// "Preis pro RUNE" oder "Gesamtbetrag" -- intern wird immer auf priceUsd (Preis pro Stück)
// normalisiert, damit die Durchschnittsberechnung (purchaseStats) einheitlich bleibt.
function PurchaseForm({
  lang,
  initial,
  onCancel,
  onSave
}) {
  const [txType, setTxType] = useState(initial && initial.type === 'sell' ? 'sell' : 'buy');
  const [date, setDate] = useState(() => {
    const d = initial ? new Date(initial.date) : new Date();
    return d.toISOString().slice(0, 10);
  });
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [mode, setMode] = useState('price');
  const [priceOrTotal, setPriceOrTotal] = useState(initial ? String(initial.priceUsd) : '');
  const [source, setSource] = useState(initial && initial.source !== 'csv' ? initial.source : 'binance');
  const amountNum = parseFloat(amount);
  const valNum = parseFloat(priceOrTotal);
  const computedPrice = mode === 'price' ? valNum : Number.isFinite(amountNum) && amountNum > 0 ? valNum / amountNum : NaN;
  const valid = Number.isFinite(amountNum) && amountNum > 0 && Number.isFinite(computedPrice) && computedPrice > 0 && !!date;
  const handleSubmit = () => {
    if (!valid) return;
    onSave({
      id: initial ? initial.id : null,
      date: new Date(date + 'T12:00:00').getTime(),
      amount: amountNum,
      priceUsd: computedPrice,
      type: txType,
      source,
      txId: initial ? initial.txId : undefined
    });
  };
  const inputStyle = {
    width: '100%',
    background: '#0E2426',
    border: '1px solid #1A3436',
    borderRadius: 6,
    padding: '6px 9px',
    color: '#DCE7E8',
    fontSize: 12,
    fontFamily: "'Inter', sans-serif",
    outline: 'none'
  };
  const labelStyle = {
    color: '#7C9698',
    fontSize: 10,
    fontWeight: 600,
    marginBottom: 3,
    display: 'block'
  };
  const modeBtnStyle = active => ({
    flex: 1,
    padding: '5px 7px',
    fontSize: 10.5,
    fontWeight: 600,
    borderRadius: 5,
    cursor: 'pointer',
    fontFamily: "'Inter', sans-serif",
    background: active ? 'rgba(0,222,225,0.16)' : '#0E2426',
    color: active ? '#00DEE1' : '#96AEB0',
    border: '1px solid #1A3436'
  });
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px solid #16292B',
      display: 'flex',
      flexDirection: 'column',
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setTxType('buy'),
    style: modeBtnStyle(txType === 'buy')
  }, t('txTypeBuy', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setTxType('sell'),
    style: modeBtnStyle(txType === 'sell')
  }, t('txTypeSell', lang))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, t('purchaseDate', lang)), /*#__PURE__*/React.createElement("input", {
    type: "date",
    value: date,
    onChange: e => setDate(e.target.value),
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, t('purchaseAmount', lang)), /*#__PURE__*/React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    value: amount,
    onChange: e => setAmount(e.target.value),
    placeholder: "0.00",
    style: inputStyle
  })), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, t('purchaseMode', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5,
      marginBottom: 5
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setMode('price'),
    style: modeBtnStyle(mode === 'price')
  }, t('purchaseModePrice', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setMode('total'),
    style: modeBtnStyle(mode === 'total')
  }, t('purchaseModeTotal', lang))), /*#__PURE__*/React.createElement("input", {
    type: "number",
    inputMode: "decimal",
    value: priceOrTotal,
    onChange: e => setPriceOrTotal(e.target.value),
    placeholder: "0.00",
    style: inputStyle
  }), mode === 'total' && Number.isFinite(computedPrice) && computedPrice > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#5C7274',
      marginTop: 3
    }
  }, "≈ ", fmtUSD(computedPrice, lang, 'usd'), " / RUNE")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("label", {
    style: labelStyle
  }, t('purchaseSource', lang)), /*#__PURE__*/React.createElement("select", {
    value: source,
    onChange: e => setSource(e.target.value),
    style: {
      ...inputStyle,
      cursor: 'pointer'
    }
  }, PURCHASE_SOURCES.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.value,
    value: s.value
  }, t(s.labelKey, lang))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 7,
      marginTop: 3
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: handleSubmit,
    disabled: !valid,
    style: {
      flex: 1,
      background: valid ? 'linear-gradient(135deg, #00DEE1, #00A8B0)' : '#1A3436',
      color: valid ? '#0A0A0A' : '#5C7274',
      border: 'none',
      borderRadius: 7,
      padding: '7px 10px',
      fontSize: 11,
      fontWeight: 700,
      cursor: valid ? 'pointer' : 'default',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('purchaseSave', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      flex: 1,
      background: 'transparent',
      color: '#96AEB0',
      border: '1px solid #1A3436',
      borderRadius: 7,
      padding: '7px 10px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('purchaseCancel', lang))));
}

// Kleiner Sparkline-Graph für das Tages-Handelsvolumen der letzten 30 Tage.
// Zeigt zusätzlich die letzte Woche (7 Tage) farblich hervorgehoben.
function VolumeSparkline({
  data,
  activePrice,
  lang,
  currency
}) {
  const width = 240;
  const height = 56;
  const padding = {
    top: 4,
    right: 2,
    bottom: 2,
    left: 2
  };
  const [volRange, setVolRange] = useState(7); // 7 oder 30 Tage — nur eine Periode wird angezeigt
  const containerRef = useRef(null);
  // Genau der gleiche Antippen-Mechanismus wie beim Portfolio-Chart: ein einzelner Tap zeigt
  // sofort (ohne Verzögerung) den Wert des am nächsten liegenden Balkens + dessen Datum,
  // folgt beim Ziehen der Fingerbewegung und verschwindet wieder beim Loslassen.
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!data || data.length < 2) return null;
  const shown = data.slice(-volRange);
  const values = shown.map(d => d.volumeRune);
  const maxV = Math.max(...values, 1);
  const minV = 0;
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;
  const xScale = i => padding.left + (shown.length > 1 ? i / (shown.length - 1) * innerW : innerW / 2);
  const yScale = v => padding.top + innerH - (v - minV) / (maxV - minV || 1) * innerH;
  const linePath = shown.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(d.volumeRune)}`).join(' ');
  const areaPath = `${linePath} L ${xScale(shown.length - 1)} ${height - padding.bottom} L ${xScale(0)} ${height - padding.bottom} Z`;
  const totalRune = shown.reduce((s, d) => s + d.volumeRune, 0);
  const totalUsd = activePrice != null ? totalRune * activePrice : null;
  const getLocalX = e => {
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.touches && e.touches.length ? e.touches[0].clientX : e.changedTouches && e.changedTouches.length ? e.changedTouches[0].clientX : e.clientX;
    return (clientX - rect.left) / rect.width * width;
  };
  const updateHoverAt = localX => {
    let idx = 0,
      minDiff = Infinity;
    for (let i = 0; i < shown.length; i++) {
      const diff = Math.abs(xScale(i) - localX);
      if (diff < minDiff) {
        minDiff = diff;
        idx = i;
      }
    }
    setHoverIdx(idx);
  };
  const handleDown = e => {
    updateHoverAt(getLocalX(e));
  };
  const handleMove = e => {
    if (hoverIdx != null || e.pointerType !== 'touch') updateHoverAt(getLocalX(e));
  };
  const clearHover = () => setHoverIdx(null);
  // Sicherheitsnetz: falls das Loslassen den Finger von der Fläche wegträgt (z.B. leicht
  // daneben endet), trotzdem zuverlässig aufräumen -- genau wie beim Portfolio-Chart.
  useEffect(() => {
    if (hoverIdx == null) return;
    window.addEventListener('pointerup', clearHover);
    window.addEventListener('touchend', clearHover);
    window.addEventListener('touchcancel', clearHover);
    return () => {
      window.removeEventListener('pointerup', clearHover);
      window.removeEventListener('touchend', clearHover);
      window.removeEventListener('touchcancel', clearHover);
    };
  }, [hoverIdx]);
  const hoverPoint = hoverIdx != null ? shown[hoverIdx] : null;
  const hoverUsd = hoverPoint != null && activePrice != null ? hoverPoint.volumeRune * activePrice : null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 6,
      marginBottom: 8
    }
  }, [7, 30].map(r => /*#__PURE__*/React.createElement("button", {
    key: r,
    onClick: () => {
      setVolRange(r);
      setHoverIdx(null);
    },
    style: {
      background: volRange === r ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: volRange === r ? '#00DEE1' : '#7C9698',
      border: `1px solid ${volRange === r ? 'rgba(0,222,225,0.55)' : '#1A3436'}`,
      borderRadius: 6,
      padding: '2px 8px',
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, rangeLabel(r, lang)))), /*#__PURE__*/React.createElement("div", {
    ref: containerRef,
    style: {
      position: 'relative',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none'
    },
    onContextMenu: e => e.preventDefault()
  }, /*#__PURE__*/React.createElement("svg", {
    width: "100%",
    height: height,
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    style: {
      display: 'block',
      touchAction: 'none',
      cursor: 'crosshair',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      WebkitTouchCallout: 'none'
    },
    onPointerDown: handleDown,
    onPointerMove: handleMove,
    onPointerUp: clearHover,
    onPointerLeave: clearHover
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "volSparkFill",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: "#00DEE1",
    stopOpacity: "0.35"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: "#00DEE1",
    stopOpacity: "0"
  }))), /*#__PURE__*/React.createElement("path", {
    d: areaPath,
    fill: "url(#volSparkFill)",
    stroke: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: linePath,
    fill: "none",
    stroke: "#00DEE1",
    strokeWidth: "1.5",
    strokeLinejoin: "round",
    strokeLinecap: "round"
  }), hoverPoint && /*#__PURE__*/React.createElement("g", {
    pointerEvents: "none"
  }, /*#__PURE__*/React.createElement("line", {
    x1: xScale(hoverIdx),
    x2: xScale(hoverIdx),
    y1: padding.top,
    y2: height - padding.bottom,
    stroke: "#2A5254",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("line", {
    x1: padding.left,
    x2: width - padding.right,
    y1: yScale(hoverPoint.volumeRune),
    y2: yScale(hoverPoint.volumeRune),
    stroke: "#2A5254",
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: xScale(hoverIdx),
    cy: yScale(hoverPoint.volumeRune),
    r: "3.5",
    fill: "#00DEE1",
    stroke: "#000000",
    strokeWidth: "1.5"
  }))), hoverPoint && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: 2,
      top: Math.min(height - 16, Math.max(0, yScale(hoverPoint.volumeRune) - 8)),
      background: '#00DEE1',
      color: '#0A0A0A',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'Inter', sans-serif",
      borderRadius: 3,
      padding: '2px 5px',
      whiteSpace: 'nowrap',
      pointerEvents: 'none'
    }
  }, hoverUsd != null ? fmtUSDCompact(hoverUsd, lang, currency) : `${hoverPoint.volumeRune.toFixed(0)} RUNE`), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      left: Math.min(width - 60, Math.max(0, xScale(hoverIdx) - 30)),
      top: height + 2,
      background: '#00DEE1',
      color: '#0A0A0A',
      fontSize: 9,
      fontWeight: 700,
      fontFamily: "'Inter', sans-serif",
      borderRadius: 3,
      padding: '2px 5px',
      whiteSpace: 'nowrap',
      pointerEvents: 'none'
    }
  }, fmtDate(hoverPoint.t, lang)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: hoverPoint ? 18 : 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 10,
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      marginBottom: 2
    }
  }, volRange === 7 ? t('last7d', lang) : t('last30d', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F5F5F5',
      fontSize: 13,
      fontWeight: 600,
      fontFamily: "'Space Grotesk', sans-serif"
    }
  }, totalUsd != null ? fmtUSDRounded(totalUsd, lang, currency) : '—')));
}

// Schlanker Zwei-Linien-Vergleichs-Chart (RUNE vs. gewählter Coin), jeweils normiert auf
// prozentuale Veränderung seit Start des Zeitraums -- so lässt sich unmittelbar ablesen,
// welcher der beiden Coins im gewählten Fenster relativ stärker oder schwächer performt hat,
// unabhängig von deren absoluter Preisgröße.
function CompareLineChart({
  seriesA,
  seriesB,
  colorA,
  colorB,
  height = 220
}) {
  const width = 600;
  const pad = {
    top: 10,
    right: 6,
    bottom: 6,
    left: 6
  };
  const toPct = arr => {
    if (!arr || arr.length < 2) return [];
    const base = arr[0].value;
    if (!base) return arr.map(d => ({
      ...d,
      pct: 0
    }));
    return arr.map(d => ({
      ...d,
      pct: (d.value - base) / base * 100
    }));
  };
  const a = toPct(seriesA);
  const b = toPct(seriesB);
  if (a.length < 2 || b.length < 2) return null;
  const allPct = [...a.map(d => d.pct), ...b.map(d => d.pct)];
  const minPct = Math.min(0, ...allPct);
  const maxPct = Math.max(0, ...allPct);
  const spread = maxPct - minPct || 1;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const xFor = (i, len) => pad.left + (len <= 1 ? 0 : i / (len - 1) * innerW);
  const yFor = pct => pad.top + innerH - (pct - minPct) / spread * innerH;
  const pathFor = arr => arr.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i, arr.length).toFixed(2)} ${yFor(d.pct).toFixed(2)}`).join(' ');
  const zeroY = yFor(0);
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: height,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("line", {
    x1: pad.left,
    x2: width - pad.right,
    y1: zeroY,
    y2: zeroY,
    stroke: "#1A3436",
    strokeWidth: "1",
    strokeDasharray: "4,4"
  }), /*#__PURE__*/React.createElement("path", {
    d: pathFor(a),
    fill: "none",
    stroke: colorA,
    strokeWidth: "2.4",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }), /*#__PURE__*/React.createElement("path", {
    d: pathFor(b),
    fill: "none",
    stroke: colorB,
    strokeWidth: "2.4",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }));
}

// Einzelne Prozent-Linie, z.B. für "Marketcap von X als Anteil der RUNE-Marketcap über Zeit".
// Anders als CompareLineChart (zwei normierte Performance-Linien) zeigt dieser Chart einen
// direkten Prozentwert je Zeitpunkt (0-100+ %), inkl. sichtbarer Y-Achsen-Beschriftung, da der
// absolute Wert selbst (nicht nur die relative Veränderung) die eigentliche Aussage ist.
function PercentRatioChart({
  series,
  color,
  height = 220
}) {
  const width = 600;
  const pad = {
    top: 10,
    right: 10,
    bottom: 6,
    left: 42
  };
  if (!series || series.length < 2) return null;
  const vals = series.map(d => d.value);
  const minV = Math.min(...vals, 0);
  const maxV = Math.max(...vals);
  const padV = (maxV - minV) * 0.12 || maxV * 0.12 || 1;
  const yLo = Math.max(0, minV - padV);
  const yHi = maxV + padV;
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const xFor = (i, len) => pad.left + (len <= 1 ? 0 : i / (len - 1) * innerW);
  const yFor = v => pad.top + innerH - (v - yLo) / (yHi - yLo || 1) * innerH;
  const pathFor = arr => arr.map((d, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i, arr.length).toFixed(2)} ${yFor(d.value).toFixed(2)}`).join(' ');
  const areaPath = `${pathFor(series)} L ${xFor(series.length - 1, series.length)},${pad.top + innerH} L ${xFor(0, series.length)},${pad.top + innerH} Z`;
  const yTicks = 4;
  const yTickVals = Array.from({
    length: yTicks + 1
  }, (_, i) => yLo + i * (yHi - yLo) / yTicks);
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: height,
    preserveAspectRatio: "none",
    style: {
      display: 'block'
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
    id: "ratioChartGrad",
    x1: "0",
    y1: "0",
    x2: "0",
    y2: "1"
  }, /*#__PURE__*/React.createElement("stop", {
    offset: "0%",
    stopColor: color,
    stopOpacity: "0.3"
  }), /*#__PURE__*/React.createElement("stop", {
    offset: "100%",
    stopColor: color,
    stopOpacity: "0"
  }))), yTickVals.map((v, i) => /*#__PURE__*/React.createElement("g", {
    key: i
  }, /*#__PURE__*/React.createElement("line", {
    x1: pad.left,
    x2: width - pad.right,
    y1: yFor(v),
    y2: yFor(v),
    stroke: "#1A3436",
    strokeDasharray: "3 3"
  }), /*#__PURE__*/React.createElement("text", {
    x: pad.left - 8,
    y: yFor(v) + 3.5,
    textAnchor: "end",
    fontSize: "10",
    fill: "#7C9698",
    fontFamily: "Inter, sans-serif"
  }, v.toFixed(v < 1 ? 3 : 1), "%"))), /*#__PURE__*/React.createElement("path", {
    d: areaPath,
    fill: "url(#ratioChartGrad)",
    stroke: "none"
  }), /*#__PURE__*/React.createElement("path", {
    d: pathFor(series),
    fill: "none",
    stroke: color,
    strokeWidth: "2.4",
    strokeLinecap: "round",
    strokeLinejoin: "round"
  }));
}

// ---------------------------------------------------------------------------
// Gedrosselter, gemeinsamer Fetch-Helfer für ALLE THORChain-/Liquify-Anfragen
// (Balances, Nodes, Netzwerk-Stats, Midgard-Actions, Churns, historische
// Node-Abfragen). Bewusst außerhalb der Komponente (Modul-Ebene), damit die
// Drosselung app-weit gilt und nicht pro Komponenten-Render neu anfängt.
//
// Warum: Liquify begrenzt Anfragen pro IP (siehe THORChain-Doku) und kappt bei
// zu vielen gleichzeitigen/schnell aufeinanderfolgenden Requests offenbar
// einfach die Verbindung — das zeigt der Browser als generisches
// "Failed to fetch", nicht als sauberen HTTP-Fehler. Ein globaler Mindest-
// abstand zwischen Anfragen plus Timeout+Retry macht das robuster, ohne dass
// jede einzelne Funktion im Code selbst darauf achten muss.
let _thorchainQueueTail = Promise.resolve();
const THORCHAIN_MIN_GAP_MS = 120; // Mindestabstand zwischen zwei Anfragen an Liquify & Co.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Einfacher fetch()-Wrapper mit Timeout via AbortController. Ohne das kann ein
// hängender Request (z.B. Binance/CoinGecko antwortet einfach nicht, statt sauber
// einen Fehler zu werfen) den umschließenden try/finally-Block für immer blockieren --
// das war der Bug, durch den der "Loading…"-Button nie mehr fertig wurde, obwohl der
// Rest der Seite (Balance/Bonded von THORNode) längst geladen war. Nach Ablauf von
// timeoutMs bricht der Request sauber mit einem AbortError ab, sodass der Code im
// catch-Block weiterlaufen kann statt ewig zu hängen.
const fetchWithTimeout = async (url, options = {}, timeoutMs = 6000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
};
const thorchainFetch = (url, options = {}, {
  timeoutMs = 8000,
  retries = 1
} = {}) => {
  // Reiht die Anfrage in eine globale Warteschlange ein, statt sie sofort loszuschicken —
  // dadurch laufen nie zwei THORChain-Requests exakt gleichzeitig los, egal wie viele
  // Funktionen im Code parallel etwas abfragen wollen.
  const run = _thorchainQueueTail.then(async () => {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(400 + Math.random() * 400);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          ...options,
          signal: controller.signal
        });
        clearTimeout(timer);
        return res;
      } catch (e) {
        clearTimeout(timer);
        lastError = e;
      }
    }
    throw lastError;
  });
  // Nächste Anfrage darf erst nach Abschluss dieser (+ Mindestabstand) starten — auch wenn
  // diese hier fehlschlägt, damit ein Fehler die Warteschlange nicht blockiert.
  _thorchainQueueTail = run.catch(() => {}).then(() => sleep(THORCHAIN_MIN_GAP_MS));
  return run;
};

// ---------------------------------------------------------------------------
// Node-Statistik & Churn-Erkennung (aktive/wollen-rein/wollen-raus Nodes)
//
// fetchAllNodes: holt die komplette THORChain-Node-Liste. Probiert mehrere Quellen der Reihe
// nach durch, bis eine antwortet -- vorher gab es hier GAR KEINEN Fallback, anders als bei den
// meisten anderen THORChain-Anfragen in der App.
//
// Quellen-Reihenfolge basiert auf dem Open-Source-Code von rune.tools (RUNE-Tools), das trotz
// Liquify-Problemen zuverlässig weiterläuft: public-thornode.nativeswap.io ist dort die aktive,
// echte Fallback-Quelle (kein API-Key nötig). thornode.thorchain.network steht zwar offiziell in
// der THORChain-Doku, war beim Test aber selbst nicht erreichbar -- bleibt trotzdem als letzter
// Versuch drin, schadet nicht.
//
// Zusätzlich: Cooldown-Tracking (COOLDOWN_MS) merkt sich pro Quelle, wenn sie kurz hintereinander
// mehrfach fehlschlägt, und überspringt sie dann für eine Weile direkt -- so verschwendet die App
// keine Zeit damit, bei jeder Aktualisierung erneut auf eine gerade bekanntermaßen kaputte Quelle
// zu warten, bevor sie zur funktionierenden wechselt.
const NODES_API_BASES = ['https://gateway.liquify.com/chain/thorchain_api', 'https://public-thornode.nativeswap.io', 'https://thornode.thorchain.network'];
const nodesApiCooldownUntil = new Map();
const nodesApiFailureCount = new Map();
const NODES_API_COOLDOWN_MS = 60000;

// Generischer Fallback-Helfer für beliebige thorchain_api-Pfade (nodes, lastblock, mimir, ...),
// nutzt dieselbe Basis-Liste + Cooldown-Tracking wie fetchAllNodes weiter unten.
const fetchThorchainApiWithFallback = async path => {
  const now = Date.now();
  const available = NODES_API_BASES.filter(b => (nodesApiCooldownUntil.get(b) || 0) <= now);
  const cooling = NODES_API_BASES.filter(b => (nodesApiCooldownUntil.get(b) || 0) > now);
  let lastErr = null;
  for (const base of [...available, ...cooling]) {
    try {
      const res = await thorchainFetch(`${base}${path}`, {
        headers: {
          'x-client-id': 'rune-portfolio-app'
        }
      }, {
        timeoutMs: 5000,
        retries: 0
      });
      if (!res.ok) throw new Error('THORCHAIN_API_FAIL_' + res.status);
      nodesApiCooldownUntil.delete(base);
      nodesApiFailureCount.delete(base);
      return res;
    } catch (e) {
      lastErr = e;
      const count = (nodesApiFailureCount.get(base) || 0) + 1;
      nodesApiFailureCount.set(base, count);
      if (count >= 2) nodesApiCooldownUntil.set(base, Date.now() + NODES_API_COOLDOWN_MS);
    }
  }
  throw lastErr || new Error('THORCHAIN_API_FAIL');
};
const fetchAllNodes = async () => {
  const res = await fetchThorchainApiWithFallback('/thorchain/nodes');
  return res.json();
};

// Bestimmt, ob/warum eine aktive Node beim nächsten Churn rausfliegen könnte:
// - explizit "requested_to_leave" (freiwillig)
// - forced_to_leave (durch's Netzwerk erzwungen)
// - älteste aktive Node (nach active_block_height)
// - schlechteste Performance (meiste slash_points)
// - niedrigster Bond
const getNodeLeaveInfo = (node, activeNodes) => {
  if (node.requested_to_leave) return {
    type: 'leaving'
  };
  if (node.forced_to_leave) return {
    type: 'forced'
  };
  if (!activeNodes.length) return null;
  const oldest = activeNodes.reduce((a, b) => Number(b.active_block_height) < Number(a.active_block_height) ? b : a);
  if (node.node_address === oldest.node_address) return {
    type: 'oldest'
  };
  const worst = activeNodes.reduce((a, b) => Number(b.slash_points) > Number(a.slash_points) ? b : a);
  if (node.node_address === worst.node_address) return {
    type: 'worst'
  };
  const lowest = activeNodes.reduce((a, b) => Number(b.total_bond) < Number(a.total_bond) ? b : a);
  if (node.node_address === lowest.node_address) return {
    type: 'lowest'
  };
  return null;
};

// Grobe Schätzung, ob eine Standby-Node beim nächsten Churn wahrscheinlich reinkommt:
// gültiger Preflight-Status + unter den bond-stärksten Standby-Nodes innerhalb der
// verfügbaren neuen Plätze.
const isNodeReadyToJoin = node => !!node.preflight_status && node.preflight_status.code === 0;

// Fasst die komplette Node-Liste zu den Zahlen zusammen, die wir anzeigen wollen, plus
// Detail-Listen für die Aufklapp-Liste.
// "joiningNodes" = ALLE Standby/Ready-Nodes mit gültigem Preflight-Status, also alle, die
// grundsätzlich bereit & berechtigt sind reinzukommen -- NICHT nur die Top-N, die laut
// NUMBEROFNEWNODESPERCHURN beim NÄCHSTEN einzelnen Churn tatsächlich drankämen (das wäre eine
// andere, viel kleinere Zahl und nicht das, was "wollen rein" meint).
const computeNodeChurnStats = nodes => {
  const activeNodes = nodes.filter(n => n.status === 'Active');
  const standbyNodes = nodes.filter(n => n.status === 'Standby' || n.status === 'Ready');
  const leavingNodes = activeNodes.map(n => ({
    node: n,
    info: getNodeLeaveInfo(n, activeNodes)
  })).filter(x => x.info);
  const joiningNodes = standbyNodes.filter(isNodeReadyToJoin);
  return {
    activeCount: activeNodes.length,
    standbyCount: standbyNodes.length,
    leavingCount: leavingNodes.length,
    joiningCount: joiningNodes.length,
    leavingNodes,
    joiningNodes
  };
};

// ---------------------------------------------------------------------------
// Kraken-Preisquelle für Vergleichs-Coins, die dort gelistet sind, aber (noch) nicht auf
// Binance zu finden sind (z.B. RUJI). Kraken erlaubt Browser-seitige Anfragen an seine
// öffentliche REST-API ohne CORS-Probleme, ähnlich wie Binance.
//
// fetchKrakenPrice: aktueller Preis + grobe 24h-Änderung (aus dem heutigen Eröffnungspreis
// abgeleitet -- Kraken liefert keinen exakten rollierenden 24h-Wert im Ticker-Endpunkt,
// das ist dieselbe Näherung, die viele einfache Preis-Widgets verwenden).
const fetchKrakenPrice = async pair => {
  const res = await fetchWithTimeout(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!res.ok) throw new Error('KRAKEN_TICKER_FAIL_' + res.status);
  const json = await res.json();
  if (json.error && json.error.length) throw new Error('KRAKEN_TICKER_ERROR_' + json.error.join(','));
  const entry = json.result && Object.values(json.result)[0];
  if (!entry) throw new Error('KRAKEN_TICKER_EMPTY');
  const last = parseFloat(entry.c && entry.c[0]);
  const openToday = parseFloat(entry.o);
  if (!Number.isFinite(last)) throw new Error('KRAKEN_TICKER_NO_PRICE');
  const changePct = Number.isFinite(openToday) && openToday > 0 ? (last - openToday) / openToday * 100 : null;
  return {
    usd: last,
    changePct
  };
};

// fetchKrakenCloseHistory: OHLC-Verlauf für den Vergleichs-Chart, auf dieselbe Form
// { date, value } gebracht wie fetchSymbolCloseHistory (Binance) und fetchGeckoCloseHistory.
const fetchKrakenCloseHistory = async (pair, days) => {
  const intervalMin = days <= 1 ? 15 : days <= 7 ? 60 : days <= 30 ? 240 : 1440;
  try {
    const res = await fetchWithTimeout(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${intervalMin}`);
    if (!res.ok) return [];
    const json = await res.json();
    if (json.error && json.error.length) return [];
    const entry = json.result && Object.values(json.result).find(v => Array.isArray(v));
    if (!entry) return [];
    return entry.map(row => ({
      date: row[0] * 1000,
      value: parseFloat(row[4])
    })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
  } catch (e) {
    return [];
  }
};

// ---------------------------------------------------------------------------
// THORChain-Pool-Preisquelle: für Coins, die selbst ein natives THORChain-Asset sind (z.B.
// TCY über den RUNE/TCY-Pool) und weder auf Binance noch auf Kraken gelistet sind. Nutzt
// dieselbe Liquify-Midgard-Basis-URL wie der Rest der App -- midgard.thorchain.network wurde
// hier bewusst entfernt, nachdem sich herausstellte, dass die Domain nicht mehr existiert
// (DNS-Fehler bei direktem Test) und dort nur unnötig Zeit verschwendet wurde, bevor die
// eigentliche Anfrage überhaupt fehlschlagen konnte.
const POOL_PRICE_MIDGARD_BASES = ['https://gateway.liquify.com/chain/thorchain_midgard/v2'];

// Aktueller Preis + grobe 24h-Änderung direkt aus dem Pool: assetPriceUSD kommt von Midgard
// selbst aus der tiefsten USD-Pool-Kette berechnet (kein CoinGecko involviert). Für die
// 24h-Änderung wird der stündliche Tiefen-Verlauf der letzten 25 Stunden herangezogen und
// der älteste bekannte Preis als "vor 24h"-Referenz genommen.
const fetchThorchainPoolPrice = async poolAsset => {
  let lastErr = null;
  for (const base of POOL_PRICE_MIDGARD_BASES) {
    try {
      const res = await thorchainFetch(`${base}/pool/${poolAsset}`, {
        headers: {
          'x-client-id': 'rune-portfolio-app'
        }
      }, {
        timeoutMs: 5000,
        retries: 0
      });
      if (!res.ok) throw new Error('POOL_FAIL_' + res.status);
      const json = await res.json();
      const usd = parseFloat(json.assetPriceUSD);
      const rune = parseFloat(json.assetPrice);
      if (!Number.isFinite(usd)) throw new Error('POOL_NO_PRICE');
      let changePct = null;
      try {
        const histRes = await thorchainFetch(`${base}/history/depths/${poolAsset}?interval=hour&count=25`, {
          headers: {
            'x-client-id': 'rune-portfolio-app'
          }
        }, {
          timeoutMs: 5000,
          retries: 0
        });
        if (histRes.ok) {
          const histJson = await histRes.json();
          const intervals = histJson.intervals || [];
          const oldest = intervals[0];
          const oldUsd = oldest ? parseFloat(oldest.assetPriceUSD) : null;
          if (Number.isFinite(oldUsd) && oldUsd > 0) changePct = (usd - oldUsd) / oldUsd * 100;
        }
      } catch (e) {/* 24h-Änderung ist optional, Hauptpreis bleibt gültig */}
      return {
        usd,
        rune,
        changePct
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('POOL_ALL_BASES_FAILED');
};

// Preisverlauf für den Vergleichs-Chart, direkt aus dem historischen Pool-Tiefen-Verlauf
// (Midgard history/depths) statt aus einer externen Preis-API. closePriceUSD ist der exakte
// Schlusspreis am Ende jedes Intervalls; assetPriceUSD dient als Fallback, falls closePriceUSD
// für ältere Intervalle mal fehlen sollte.
const fetchThorchainPoolCloseHistory = async (poolAsset, days) => {
  const {
    interval,
    count
  } = days <= 1 ? {
    interval: '5min',
    count: 288
  } : days <= 7 ? {
    interval: 'hour',
    count: 168
  } : days <= 30 ? {
    interval: 'day',
    count: 30
  } : days <= 90 ? {
    interval: 'day',
    count: 90
  } : {
    interval: 'day',
    count: 370
  };
  for (const base of POOL_PRICE_MIDGARD_BASES) {
    try {
      const res = await thorchainFetch(`${base}/history/depths/${poolAsset}?interval=${interval}&count=${count}`, {
        headers: {
          'x-client-id': 'rune-portfolio-app'
        }
      }, {
        timeoutMs: 5000,
        retries: 0
      });
      if (!res.ok) continue;
      const json = await res.json();
      const intervals = json.intervals || [];
      const points = intervals.map(iv => ({
        date: parseInt(iv.endTime, 10) * 1000,
        value: parseFloat(iv.closePriceUSD != null ? iv.closePriceUSD : iv.assetPriceUSD)
      })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
      if (points.length) return points;
    } catch (e) {/* nächste Basis probieren */}
  }
  return [];
};

// Zirkulierende Menge eines nativen THORChain-Denoms (z.B. "rune" oder "tcy") direkt über den
// Cosmos-SDK-Bank-Endpunkt von THORNode. Nutzt denselben Fallback-Helfer wie fetchAllNodes.
const fetchThorchainDenomSupply = async denom => {
  const res = await fetchThorchainApiWithFallback(`/cosmos/bank/v1beta1/supply/by_denom?denom=${denom}`);
  const json = await res.json();
  const raw = json && json.amount && json.amount.amount;
  const amount = raw != null ? parseInt(raw, 10) / 1e8 : null;
  if (!Number.isFinite(amount)) throw new Error('SUPPLY_MISSING');
  return amount;
};
function ThorchainPortfolio() {
  // lang wird ganz oben deklariert (statt weiter unten bei den anderen UI-Einstellungen),
  // weil der Node-Polling-Effect weiter unten im Code sie bereits braucht, um
  // Benachrichtigungen in der aktuell gewählten Sprache zu erzeugen.
  const [lang, setLang] = useState(() => {
    try {
      return localStorage.getItem('tp_lang') || 'en';
    } catch (e) {
      return 'en';
    }
  });

  // Eigene Wallet-Adresse wird automatisch lokal im Browser gespeichert (localStorage),
  // sobald sie erfolgreich geladen wurde — kein manuelles "Merken" mehr nötig.
  const [address, setAddress] = useState(() => {
    try {
      return localStorage.getItem('tp_address') || '';
    } catch (e) {
      return '';
    }
  });
  // Liste aller getrackten Wallet-Adressen (für die kombinierte Summenansicht). Migriert
  // automatisch die alte Einzel-Adresse, falls jemand die App schon vorher genutzt hat.
  const [wallets, setWallets] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_wallets');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr;
      }
      const legacy = localStorage.getItem('tp_address');
      return legacy && legacy.trim() ? [legacy.trim()] : [];
    } catch (e) {
      return [];
    }
  });
  const [walletListExpanded, setWalletListExpanded] = useState(false); // Wallet-Adressen standardmäßig eingeklappt (dezent, Privatsphäre)
  useEffect(() => {
    try {
      localStorage.setItem('tp_wallets', JSON.stringify(wallets));
    } catch (e) {}
  }, [wallets]);
  const addWallet = addr => {
    const clean = (addr || '').trim();
    if (!clean || !clean.startsWith('thor1')) return false;
    setWallets(prev => prev.includes(clean) ? prev : [...prev, clean]);
    return true;
  };
  const removeWallet = addr => {
    setWallets(prev => prev.filter(w => w !== addr));
  };

  // --- Ø Kaufpreis: manuell erfasste RUNE-Käufe (CEX + DEX), lokal gespeichert. ---
  // Warum manuell? On-Chain-Swaps über THORChain könnten theoretisch automatisch erkannt
  // werden, aber ein Kauf über eine Börse (CEX) hinterlässt auf der Blockchain keine Spur --
  // eine Wallet sieht nur "X RUNE angekommen", nicht was dafür bezahlt wurde. Manuelle Erfassung
  // ist der einzige Weg, der für JEDE Kaufquelle funktioniert.
  const [purchases, setPurchases] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_purchases');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_purchases', JSON.stringify(purchases));
    } catch (e) {}
  }, [purchases]);
  const [purchaseCardOpen, setPurchaseCardOpen] = useState(false);
  const [purchaseFormOpen, setPurchaseFormOpen] = useState(false);
  const [purchaseListExpanded, setPurchaseListExpanded] = useState(false);
  const [selectedPurchaseIds, setSelectedPurchaseIds] = useState([]);
  // Eigenes, zum App-Design passendes Bestätigungsfenster statt des nativen
  // Browser-window.confirm()-Dialogs (der optisch nicht zur App passt).
  const [confirmDialog, setConfirmDialog] = useState(null); // { message, onConfirm } | null
  // Persistente Liste gelöschter IDs -- wird beim nächsten Sync-Push an den Server geschickt,
  // damit gelöschte Einträge dort als "Tombstone" vermerkt werden und nicht durch ein anderes
  // Gerät, das sie noch kennt, versehentlich wieder zurückgeholt werden.
  const [deletedPurchaseIds, setDeletedPurchaseIds] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_purchases_deleted_ids');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_purchases_deleted_ids', JSON.stringify(deletedPurchaseIds.slice(-1000)));
    } catch (e) {}
  }, [deletedPurchaseIds]);
  const markDeleted = ids => setDeletedPurchaseIds(prev => [...new Set([...prev, ...ids])]);
  const togglePurchaseSelected = id => {
    setSelectedPurchaseIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const deleteSelectedPurchases = () => {
    markDeleted(selectedPurchaseIds);
    setPurchases(prev => prev.filter(p => !selectedPurchaseIds.includes(p.id)));
    setSelectedPurchaseIds([]);
  };
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [purchaseImportError, setPurchaseImportError] = useState(null);
  const csvImportInputRef = useRef(null);
  const addOrUpdatePurchase = entry => {
    setPurchases(prev => {
      if (entry.id) {
        return prev.map(p => p.id === entry.id ? {
          ...entry
        } : p);
      }
      return [...prev, {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      }];
    });
  };
  const deletePurchase = id => {
    markDeleted([id]);
    setPurchases(prev => prev.filter(p => p.id !== id));
  };

  // --- Geräteübergreifender Sync der Kaufliste, verknüpft mit der ersten getrackten Wallet ---
  // Bisher nur lokal im Browser gespeichert (localStorage) -- auf einem anderen Gerät/Browser
  // war die Liste dadurch leer, obwohl dieselbe Wallet-Adresse eingetragen war. Nutzt denselben
  // Cloudflare Worker + dieselbe D1-Datenbank wie die Bond-Rewards-Historie (neue /purchases-
  // Endpunkte dort, siehe Worker-Code).
  // Wie Bond-Rewards in der Ø-Kaufpreis-Berechnung bewertet werden: 'free' (Standard, wie
  // bisher) -- Rewards zählen als Käufe zum Preis 0, erhöhen also die gehaltene Menge OHNE die
  // Kostenbasis zu erhöhen, verdünnen den Ø-Preis nach unten. 'market' -- Rewards werden zu
  // ihrem tatsächlichen Marktpreis zum Empfangszeitpunkt bewertet (wie es z.B. in Deutschland
  // für die steuerliche Behandlung von Staking-/Bond-Rewards als Einkommen üblich ist: der Wert
  // bei Erhalt wird zur Kostenbasis für die künftige Veräußerung). Keine der beiden Varianten
  // ist "die eine richtige" -- hängt von Land/Zweck ab.
  const [rewardValuationMethod, setRewardValuationMethod] = useState(() => {
    try {
      const saved = localStorage.getItem('tp_reward_valuation_method');
      return saved === 'market' ? 'market' : 'free';
    } catch (e) {
      return 'free';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_reward_valuation_method', rewardValuationMethod);
    } catch (e) {}
  }, [rewardValuationMethod]);

  // Methode für die Ø-Kaufpreis-/Kostenbasis-Berechnung: 'average' (gleitender Durchschnitt,
  // wie z.B. viele Exchanges anzeigen und wie es HMRC/UK per Section-104-Pool oder Kanadas ACB
  // vorschreiben) vs. 'fifo' (First In, First Out -- in Deutschland nach §23 EStG für
  // Privatanleger vorgeschrieben, in den USA seit Rev. Proc. 2024-28 der Standard). Lokal
  // gemerkt, da die "richtige" Methode je nach Land unterschiedlich ist -- keine der beiden ist
  // per se "korrekter", nur unterschiedlich vorgeschrieben.
  const [costBasisMethod, setCostBasisMethod] = useState(() => {
    try {
      const saved = localStorage.getItem('tp_cost_basis_method');
      return saved === 'fifo' ? 'fifo' : 'average';
    } catch (e) {
      return 'average';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_cost_basis_method', costBasisMethod);
    } catch (e) {}
  }, [costBasisMethod]);

  const [donationCopied, setDonationCopied] = useState(null);
  const [donationOpen, setDonationOpen] = useState(false);

  const [purchasesSyncStatus, setPurchasesSyncStatus] = useState('idle'); // 'idle'|'syncing'|'synced'|'error'
  const [syncDebugInfo, setSyncDebugInfo] = useState(null); // { remoteCount, updatedAt } -- fürs manuelle Nachschauen
  const purchasesSyncedOnceRef = useRef(false);
  const purchasesSyncAddr = wallets[0] || null;

  // Vom Server laden und mit dem lokalen Stand zusammenführen (Duplikate über Datum+Menge+Preis
  // erkannt, wie beim CSV-Import; bekannte gelöschte IDs werden ausgeschlossen).
  const pullAndMergePurchases = useCallback(async () => {
    if (!purchasesSyncAddr) return;
    setPurchasesSyncStatus('syncing');
    try {
      const res = await fetchWithTimeout(`${PURCHASES_SYNC_BACKEND_BASE}/purchases?address=${encodeURIComponent(purchasesSyncAddr)}&_=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('SYNC_FETCH_FAIL');
      const data = await res.json();
      const remotePurchases = Array.isArray(data.purchases) ? data.purchases : [];
      // Server liefert die VOLLSTÄNDIGE Tombstone-Liste (alle jemals gelöschten IDs, auch von
      // anderen Geräten) -- damit auch eigene, lokal noch vorhandene Alteinträge entfernt werden
      // können, die DIESES Gerät nie selbst gelöscht hat, aber ein anderes Gerät schon.
      const serverDeletedIds = Array.isArray(data.deletedIds) ? data.deletedIds : [];
      if (serverDeletedIds.length) {
        setDeletedPurchaseIds(prev => [...new Set([...prev, ...serverDeletedIds])]);
      }
      setSyncDebugInfo({
        remoteCount: remotePurchases.length,
        updatedAt: data.updatedAt || null
      });
      // Berechnungs-Einstellungen (Ø/FIFO, Rewards frei/@Markt) mitziehen, damit alle Geräte
      // mit derselben Wallet-Adresse denselben Ø-Kaufpreis anzeigen. Ohne das rechnet jedes
      // Gerät mit seinen eigenen, lokal gespeicherten Einstellungen und zeigt eine andere Zahl.
      // Nur setzen, wenn der Server überhaupt einen (gültigen) Wert kennt -- sonst bleibt der
      // lokale Stand bestehen und wird beim nächsten Push zum Server hochgeschrieben.
      const remoteSettings = data && data.settings;
      if (remoteSettings && typeof remoteSettings === 'object') {
        if (remoteSettings.costBasisMethod === 'fifo' || remoteSettings.costBasisMethod === 'average') {
          setCostBasisMethod(remoteSettings.costBasisMethod);
        }
        if (remoteSettings.rewardValuationMethod === 'market' || remoteSettings.rewardValuationMethod === 'free') {
          setRewardValuationMethod(remoteSettings.rewardValuationMethod);
        }
      }
      setPurchases(localPurchases => {
        // Zuerst: lokale Einträge entfernen, die laut Server-Tombstone-Liste bereits (auf
        // irgendeinem Gerät) gelöscht wurden.
        const cleanedLocal = serverDeletedIds.length ? localPurchases.filter(p => !p.id || !serverDeletedIds.includes(p.id)) : localPurchases;
        const merged = [...cleanedLocal];
        // WICHTIG: nur über die eindeutige ID abgleichen, nicht mehr über Datum/Menge/Preis --
        // siehe ausführlicher Kommentar im Worker-Code (handlePurchases) zum selben Thema.
        const isDup = row => row.id ? merged.some(p => p.id === row.id) : false;
        for (const r of remotePurchases) {
          if (r && Number.isFinite(r.amount) && Number.isFinite(r.priceUsd) && !isDup(r) && !(r.id && serverDeletedIds.includes(r.id))) merged.push(r);
        }
        return merged;
      });
      setPurchasesSyncStatus('synced');
      purchasesSyncedOnceRef.current = true;
    } catch (e) {
      setPurchasesSyncStatus('error');
    }
  }, [purchasesSyncAddr]);

  // Aktuellen lokalen Stand sofort (nicht verzögert) zum Server schreiben.
  const pushPurchasesNow = useCallback(async () => {
    if (!purchasesSyncAddr) return;
    try {
      const res = await fetchWithTimeout(`${PURCHASES_SYNC_BACKEND_BASE}/purchases?address=${encodeURIComponent(purchasesSyncAddr)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          purchases,
          deletedIds: deletedPurchaseIds,
          settings: {
            costBasisMethod,
            rewardValuationMethod
          }
        }),
        cache: 'no-store'
      }, 8000);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.purchases)) setSyncDebugInfo({
          remoteCount: data.purchases.length,
          updatedAt: data.updatedAt || null
        });
      }
    } catch (e) {/* stiller Fehlschlag, Debounce-Push versucht es später erneut */}
  }, [purchases, purchasesSyncAddr, deletedPurchaseIds, costBasisMethod, rewardValuationMethod]);

  // Manueller "Jetzt synchronisieren"-Button: erst vom Server laden+zusammenführen, danach den
  // (jetzt zusammengeführten) Stand sofort zurückschreiben -- stellt sicher, dass beide Richtungen
  // einmal durchlaufen, ohne auf den Neustart der Seite angewiesen zu sein.
  const manualSyncNow = async () => {
    await pullAndMergePurchases();
    await pushPurchasesNow();
  };

  // Räumt bereits vorhandene lokale Duplikate einmalig auf (z.B. von früheren Test-Importen vor
  // dem Duplikat-Schutz) -- im Unterschied zum laufenden Duplikat-Schutz beim Import/Sync, der
  // nur das NEUE Hinzufügen von Duplikaten verhindert, aber bereits bestehende nicht rückwirkend
  // entfernt.
  const [dedupeResultCount, setDedupeResultCount] = useState(null);
  const cleanupDuplicatePurchases = () => {
    setPurchases(prev => {
      // WICHTIG: nur über die eindeutige ID abgleichen, nicht mehr über Datum/Menge/Preis --
      // sonst würden echte, unterschiedliche Trades mit zufällig identischen Werten (z.B.
      // mehrere Teil-Ausführungen eines Orders zum selben Preis) fälschlich entfernt.
      const result = [];
      const seenIds = new Set();
      for (const p of prev) {
        if (p.id) {
          if (seenIds.has(p.id)) continue;
          seenIds.add(p.id);
        }
        result.push(p);
      }
      setDedupeResultCount(prev.length - result.length);
      return result;
    });
  };

  // Beim Start bzw. wenn sich die erste getrackte Wallet ändert: einmal automatisch laden.
  useEffect(() => {
    purchasesSyncedOnceRef.current = false;
    pullAndMergePurchases();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchasesSyncAddr]);

  // Nach dem ersten erfolgreichen Laden: jede Änderung an der Kaufliste ODER an den
  // Berechnungs-Einstellungen (verzögert, damit nicht bei jedem einzelnen Tastendruck gesendet
  // wird) zurück auf den Server schreiben, damit andere Geräte mit derselben Wallet-Adresse den
  // aktuellen Stand sehen. Gelöschte IDs werden als Tombstones mitgeschickt (siehe Worker-Code),
  // damit sie nicht von einem anderen Gerät versehentlich wieder zurückgeholt werden.
  useEffect(() => {
    if (!purchasesSyncAddr || !purchasesSyncedOnceRef.current) return;
    const timer = setTimeout(() => {
      pushPurchasesNow();
    }, 1500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [purchases, purchasesSyncAddr, deletedPurchaseIds, costBasisMethod, rewardValuationMethod]);

  // Sehr simpler, toleranter CSV-Parser: erkennt Spalten anhand der Kopfzeile (mehrsprachig/
  // mehrere gängige Börsen-Exportformate) statt ein einziges starres Format vorauszusetzen.
  // Erkannt werden u.a. Binance- ("Date(UTC)", "Executed", "Amount"), Kraken- ("time", "vol",
  // "price") und generische Exporte ("date", "amount"/"quantity", "price"/"total").
  // Robuster CSV-Parser für Kauf-Historie-Exports -- funktioniert unabhängig von Sprache/Land:
  // - Trennzeichen wird automatisch erkannt (Komma, Semikolon, Tab -- deutsche Exporte nutzen
  //   fast immer Semikolon, weil das Komma schon als Dezimaltrenner verwendet wird)
  // - Zahlenformat wird automatisch erkannt (deutsch "1.234,56" vs. englisch "1,234.56")
  // - Datumsformat wird automatisch erkannt (deutsch/europäisch "TT.MM.JJJJ [HH:MM[:SS]]"
  //   zusätzlich zu ISO/US-Formaten, die Date.parse ohnehin versteht)
  // - Felder in Anführungszeichen (die selbst das Trennzeichen enthalten können) werden korrekt
  //   behandelt, nicht einfach naiv am Trennzeichen gesplittet
  const detectCsvDelimiter = line => {
    let best = ',';
    let bestCount = -1;
    for (const c of [';', ',', '\t']) {
      const count = line.split(c).length - 1;
      if (count > bestCount) {
        bestCount = count;
        best = c;
      }
    }
    return best;
  };
  const splitCsvLine = (line, delimiter) => {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        result.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result.map(c => c.trim());
  };
  // Erkennt sowohl deutsches ("1.234,56") als auch englisches ("1,234.56") Zahlenformat.
  const parseLocaleNumber = raw => {
    if (raw == null) return NaN;
    let s = String(raw).trim().replace(/[^\d,.\-]/g, ''); // Währungssymbole/Buchstaben/Leerzeichen weg
    if (!s) return NaN;
    const hasComma = s.includes(',');
    const hasDot = s.includes('.');
    if (hasComma && hasDot) {
      // Das letzte vorkommende Zeichen (Komma ODER Punkt) ist der Dezimaltrenner, alles davor
      // sind Tausendertrenner.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        s = s.replace(/\./g, '').replace(',', '.'); // deutsches Format: 1.234,56
      } else {
        s = s.replace(/,/g, ''); // englisches Format: 1,234.56
      }
    } else if (hasComma) {
      // Nur Kommas vorhanden: mehr als eines -> reine Tausendertrenner ohne Nachkommastellen,
      // genau eines -> als Dezimaltrenner behandeln (deutsches Format).
      const parts = s.split(',');
      s = parts.length > 2 ? parts.join('') : s.replace(',', '.');
    }
    // Nur Punkt(e) vorhanden: bereits gültiges Zahlenformat, nichts zu tun.
    return parseFloat(s);
  };
  // Erkennt zusätzlich zu ISO/US-Formaten (die Date.parse direkt versteht) auch das deutsche/
  // europäische Format "TT.MM.JJJJ" bzw. "TT.MM.JJJJ HH:MM[:SS]".
  const parseFlexibleDate = raw => {
    if (!raw) return NaN;
    const s = String(raw).trim();
    const deMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (deMatch) {
      const [, dd, mm, yyyy, hh, min, sec] = deMatch;
      const year = yyyy.length === 2 ? 2000 + parseInt(yyyy, 10) : parseInt(yyyy, 10);
      const d = new Date(year, parseInt(mm, 10) - 1, parseInt(dd, 10), hh ? parseInt(hh, 10) : 12, min ? parseInt(min, 10) : 0, sec ? parseInt(sec, 10) : 0);
      if (!isNaN(d.getTime())) return d.getTime();
    }
    const iso = Date.parse(s.replace(' ', 'T'));
    return isNaN(iso) ? NaN : iso;
  };
  // Näherungsweise Umrechnungskurse in USD, falls die CSV Beträge in einer anderen Währung
  // ausweist (z.B. deutsche Exporte oft in EUR). Keine historisch exakten Tageskurse -- aber
  // deutlich besser, als eine andere Währung stillschweigend 1:1 als USD zu behandeln.
  const APPROX_FIAT_TO_USD = {
    usd: 1,
    eur: 1.08,
    gbp: 1.27,
    chf: 1.13,
    jpy: 0.0067,
    cad: 0.73,
    aud: 0.65
  };
  // USD-Stablecoins gelten als 1:1 zu USD -- im Gegensatz zu volatilen Kryptowährungen wie ETH
  // oder BTC, für die es hier KEINEN verlässlichen Umrechnungskurs gibt (siehe Prüfung unten in
  // parsePurchaseCsv).
  const STABLECOIN_CODES = ['usdt', 'usdc', 'dai', 'busd', 'tusd', 'usdp', 'fdusd', 'usde', 'pyusd'];
  const parsePurchaseCsv = async text => {
    const clean = text.replace(/^\uFEFF/, ''); // BOM entfernen (typisch bei Excel-Exporten)
    const lines = clean.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return {
      rows: [],
      skipped: 0
    };
    // Die echte Kopfzeile liegt nicht immer in Zeile 1 -- manche Exporte haben davor noch
    // Titel-/Beschreibungszeilen. Deshalb werden die ersten Zeilen durchsucht, bis eine Zeile
    // gefunden wird, die sowohl eine erkennbare Datums- als auch eine Mengen-Spalte enthält.
    let headerLineIdx = 0;
    let delimiter = detectCsvDelimiter(lines[0]);
    let header = splitCsvLine(lines[0], delimiter).map(c => c.replace(/^"|"$/g, '').toLowerCase());
    const looksLikeDate = h => ['date(utc)', 'date', 'time', 'zeit', 'datum', 'timestamp'].some(n => h.includes(n));
    const looksLikeAmount = h => ['executed', 'amount', 'quantity', 'menge', 'anzahl', 'vol', 'size', 'filled'].some(n => h.includes(n));
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const testDelim = detectCsvDelimiter(lines[i]);
      const testHeader = splitCsvLine(lines[i], testDelim).map(c => c.replace(/^"|"$/g, '').toLowerCase());
      if (testHeader.some(looksLikeDate) && testHeader.some(looksLikeAmount)) {
        headerLineIdx = i;
        delimiter = testDelim;
        header = testHeader;
        break;
      }
    }
    const splitLine = l => splitCsvLine(l, delimiter).map(c => c.replace(/^"|"$/g, ''));
    // exclude: Spalten, die schon einem anderen Feld zugeordnet wurden, werden bei der Suche
    // übersprungen -- verhindert z.B., dass "Spot Price Currency" (enthält "price") fälschlich
    // als Preis-Spalte erkannt wird, obwohl eigentlich eine reine Währungs-Bezeichnung gemeint ist.
    const findCol = (names, exclude = []) => header.findIndex((h, idx) => !exclude.includes(idx) && names.some(n => h === n || h.includes(n)));
    const dateIdx = findCol(['date(utc)', 'date', 'time', 'zeit', 'datum', 'timestamp']);
    // Erkennt eine Coin/Pair-Spalte (z.B. "Pair", "Symbol", "Asset", "Market") -- wichtig bei
    // Exporten, die ALLE gehandelten Coins gemischt auflisten (nicht nur RUNE), damit nur
    // RUNE-Zeilen übernommen werden.
    const pairIdx = findCol(['pair', 'symbol', 'market', 'base asset', 'coin', 'asset']);
    const currencyIdx = findCol(['währung', 'currency', 'curr'], [pairIdx]);
    const amountIdx = findCol(['executed', 'amount', 'quantity', 'menge', 'anzahl', 'vol', 'size', 'filled'], [pairIdx]);
    const priceIdx = findCol(['price', 'preis', 'kurs', 'rate'], [currencyIdx]);
    const totalIdx = findCol(['total', 'quote qty', 'gesamt', 'betrag', 'wert', 'cost'], [currencyIdx]);
    // Manche Börsen-Exporte (z.B. KuCoin, Binance) listen Käufe UND Verkäufe (und teils weitere
    // Vorgänge wie Ein-/Auszahlungen, Transfers, Conversions) in derselben Datei, unterschieden
    // nur über eine "Typ"/"Type"/"Side"-Spalte. Ohne diese Prüfung wurden solche Zeilen bisher
    // fälschlich als Käufe importiert und haben den Ø-Kaufpreis verfälscht.
    // Manche Börsen-Exporte (z.B. KuCoin, Binance) listen Käufe UND Verkäufe (und teils weitere
    // Vorgänge wie Ein-/Auszahlungen, Transfers, Conversions) in derselben Datei, unterschieden
    // nur über eine "Typ"/"Type"/"Side"-Spalte. Verkäufe werden jetzt mit importiert (als eigener
    // Transaktionstyp, siehe txType unten) und fließen in die Ø-Kaufpreis-Berechnung mit ein --
    // nur echte Nicht-Handels-Vorgänge (Ein-/Auszahlung, Transfer, Convert) bleiben ausgeschlossen.
    const typeIdx = findCol(['typ', 'type', 'side']);
    const SELL_LABELS = ['verkauf', 'sell', 'sold', 'sale', 'vente', 'venta'];
    const EXCLUDE_LABELS = ['withdrawal', 'withdraw', 'auszahlung', 'deposit', 'einzahlung', 'transfer', 'überweisung', 'send', 'receive', 'convert'];
    const rows = [];
    // Zeilen, deren Preiswährung weder eine bekannte Fiat-Währung noch ein Stablecoin ist (z.B.
    // "0.0002 ETH" statt "0.70 USDT" -- kommt vor, wenn direkt Coin-gegen-Coin statt gegen eine
    // Stable-/Fiat-Währung gehandelt wurde). Werden hier zunächst NUR gesammelt (mit dem
    // Rohpreis in der Fremdwährung), die eigentliche Umrechnung zu USD passiert weiter unten
    // gebündelt über eine historische Kurs-Abfrage -- gruppiert nach (Währung, Tag), damit nicht
    // pro Zeile ein eigener Netzwerk-Request nötig ist.
    const pendingConversions = [];
    let skipped = 0;
    for (let i = headerLineIdx + 1; i < lines.length; i++) {
      const cols = splitLine(lines[i]);
      let txType = 'buy';
      if (typeIdx >= 0) {
        const typeRaw = (cols[typeIdx] || '').trim().toLowerCase();
        if (EXCLUDE_LABELS.some(s => typeRaw.includes(s))) {
          skipped++;
          continue;
        }
        if (SELL_LABELS.some(s => typeRaw.includes(s))) txType = 'sell';
      }
      if (pairIdx >= 0) {
        const pairRaw = (cols[pairIdx] || '').trim().toLowerCase();
        if (pairRaw && !pairRaw.includes('rune')) {
          skipped++;
          continue;
        }
      }
      const dateRaw = dateIdx >= 0 ? cols[dateIdx] : null;
      const amountRaw = amountIdx >= 0 ? cols[amountIdx] : null;
      const priceRaw = priceIdx >= 0 ? cols[priceIdx] : null;
      const totalRaw = totalIdx >= 0 ? cols[totalIdx] : null;
      const currencyRaw = currencyIdx >= 0 ? (cols[currencyIdx] || '').trim().toLowerCase() : 'usd';
      const isKnownFiat = APPROX_FIAT_TO_USD[currencyRaw] != null;
      const isStablecoin = STABLECOIN_CODES.includes(currencyRaw);
      const dateMs = dateRaw ? parseFlexibleDate(dateRaw) : NaN;
      const amount = amountRaw != null ? parseLocaleNumber(amountRaw) : NaN;
      if (currencyRaw && !isKnownFiat && !isStablecoin) {
        const rawPrice = priceRaw != null ? parseLocaleNumber(priceRaw) : NaN;
        const rawTotal = totalRaw != null ? parseLocaleNumber(totalRaw) : NaN;
        const hasUsablePrice = Number.isFinite(rawPrice) && rawPrice > 0 || Number.isFinite(rawTotal) && rawTotal > 0 && Number.isFinite(amount) && amount > 0;
        if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(dateMs) || !hasUsablePrice) {
          skipped++;
          continue;
        }
        pendingConversions.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
          date: dateMs,
          type: txType,
          amount,
          rawPricePerRune: Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : rawTotal / amount,
          currencyCode: currencyRaw.toUpperCase()
        });
        continue;
      }
      const fxRate = isKnownFiat ? APPROX_FIAT_TO_USD[currencyRaw] : 1;
      let price = priceRaw != null ? parseLocaleNumber(priceRaw) * fxRate : NaN;
      const total = totalRaw != null ? parseLocaleNumber(totalRaw) * fxRate : NaN;
      if (!Number.isFinite(price) && Number.isFinite(total) && Number.isFinite(amount) && amount > 0) {
        price = total / amount;
      }
      if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(price) || price <= 0) {
        skipped++;
        continue;
      }
      rows.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${i}`,
        date: Number.isFinite(dateMs) ? dateMs : Date.now(),
        type: txType,
        amount,
        priceUsd: price,
        source: 'csv'
      });
    }

    // Historische Umrechnungskurse für die gesammelten Fremdwährungs-Zeilen abrufen -- gebündelt
    // nach (Währung, Tag), genau wie beim bestehenden Kurs-Lookup für Swap-/Transfer-Vorschläge
    // weiter oben in dieser Datei (fetchExactSwapSuggestions/fetchApproxTransferSuggestions):
    // stündliche Binance-Kerzen für "{WÄHRUNG}USDT" an dem jeweiligen Tag, nächstliegender
    // Stundenwert zum genauen Zeitpunkt der Zeile. Existiert für die Währung kein Binance-Markt
    // (z.B. ein sehr obskurer Token) oder schlägt die Abfrage fehl, wird die betroffene Zeile
    // als letztes Sicherheitsnetz übersprungen statt mit einem falschen Kurs versehen zu werden.
    if (pendingConversions.length) {
      const uniqueDayGroups = new Map(); // key `${SYMBOL}_${dayKey}` -> { symbol, dayKey }
      for (const pc of pendingConversions) {
        const dayKey = Math.floor(pc.date / 86400000);
        uniqueDayGroups.set(`${pc.currencyCode}_${dayKey}`, {
          symbol: pc.currencyCode,
          dayKey
        });
      }
      const priceCache = new Map(); // key -> array of {date,value} Punkte, oder null bei Fehlschlag
      for (const {
        symbol,
        dayKey
      } of uniqueDayGroups.values()) {
        const dayStartMs = dayKey * 86400000;
        const dayEndMs = dayStartMs + 86400000;
        const cacheKey = `${symbol}_${dayKey}`;
        try {
          const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1h&startTime=${dayStartMs}&endTime=${dayEndMs}&limit=24`);
          if (res.ok) {
            const raw = await res.json();
            const points = raw.map(k => ({
              date: k[0],
              value: parseFloat(k[4])
            })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
            priceCache.set(cacheKey, points.length ? points : null);
          } else {
            priceCache.set(cacheKey, null);
          }
        } catch (e) {
          priceCache.set(cacheKey, null);
        }
      }
      const findNearestPoint = (points, dateMs) => {
        let best = points[0];
        let bestDiff = Math.abs(points[0].date - dateMs);
        for (const p of points) {
          const diff = Math.abs(p.date - dateMs);
          if (diff < bestDiff) {
            best = p;
            bestDiff = diff;
          }
        }
        return best.value;
      };
      for (const pc of pendingConversions) {
        const dayKey = Math.floor(pc.date / 86400000);
        const points = priceCache.get(`${pc.currencyCode}_${dayKey}`);
        if (!points) {
          skipped++;
          continue;
        }
        const usdRate = findNearestPoint(points, pc.date);
        const priceUsd = pc.rawPricePerRune * usdRate;
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
          skipped++;
          continue;
        }
        rows.push({
          id: pc.id,
          date: pc.date,
          type: pc.type,
          amount: pc.amount,
          priceUsd,
          source: 'csv'
        });
      }
    }
    return {
      rows,
      skipped
    };
  };
  const [purchaseImportLoading, setPurchaseImportLoading] = useState(false);
  const handlePurchaseCsvFile = file => {
    setPurchaseImportError(null);
    const reader = new FileReader();
    reader.onload = async () => {
      setPurchaseImportLoading(true);
      try {
        const {
          rows,
          skipped
        } = await parsePurchaseCsv(String(reader.result || ''));
        if (!rows.length) {
          setPurchaseImportError(t('csvImportNoRows', lang));
          return;
        }
        // Duplikat-Schutz: eine Zeile mit (fast) demselben Datum, derselben Menge und demselben
        // Preis wie ein bereits VORHANDENER Eintrag (aus einem früheren Import) wird übersprungen.
        // Verhindert, dass ein versehentlicher Doppel-Import (z.B. dieselbe Datei zweimal
        // hochgeladen) den investierten Betrag/Ø-Kaufpreis verdoppelt oder aufbläht.
        // WICHTIG: Wird NUR gegen bereits vorhandene Einträge geprüft, nicht gegen andere Zeilen
        // innerhalb DESSELBEN frischen Imports -- sonst würden zwei echte, unterschiedliche
        // Trades, die zufällig exakt dieselbe Größe/denselben Preis zur selben Sekunde haben
        // (z.B. zwei gleich große Teil-Ausführungen eines Orders), sich gegenseitig fälschlich
        // als Duplikat verwerfen, obwohl beide real sind.
        const isDuplicate = (row, existing) => existing.some(p => Math.abs(p.date - row.date) < 60000 &&
        // gleiche Minute
        Math.abs(p.amount - row.amount) < 0.0001 && Math.abs(p.priceUsd - row.priceUsd) < 0.0001);
        let duplicates = 0;
        const newRows = [];
        setPurchases(prevPurchases => {
          for (const row of rows) {
            if (isDuplicate(row, prevPurchases)) {
              duplicates++;
              continue;
            }
            newRows.push(row);
          }
          if (!newRows.length) return prevPurchases;
          // Batch-ID + Dateiname an jede importierte Zeile hängen, damit ein kompletter Import
          // später mit einem Klick wieder rückgängig gemacht werden kann (siehe importBatches).
          const importBatchId = `csv-${Date.now()}`;
          const taggedRows = newRows.map(r => ({
            ...r,
            importBatchId,
            importFileName: file.name
          }));
          return [...prevPurchases, ...taggedRows];
        });
        setPurchaseListExpanded(true);
        if (!newRows.length && duplicates > 0) {
          setPurchaseImportError(t('csvImportAllDuplicates', lang));
        } else if (skipped > 0 || duplicates > 0) {
          const parts = [];
          if (skipped > 0) parts.push(t('csvImportPartial', lang).replace('{n}', String(skipped)));
          if (duplicates > 0) parts.push(t('csvImportDuplicatesSkipped', lang).replace('{n}', String(duplicates)));
          setPurchaseImportError(parts.join(' '));
        }
      } catch (e) {
        setPurchaseImportError(t('csvImportFailed', lang));
      } finally {
        setPurchaseImportLoading(false);
      }
    };
    reader.onerror = () => setPurchaseImportError(t('csvImportFailed', lang));
    reader.readAsText(file);
  };
  // Gruppiert alle importierten Käufe nach Import-Datei (importBatchId), damit man einen
  // gesamten Datei-Import mit einem Klick wieder entfernen kann, statt jede Zeile einzeln zu
  // löschen. Ältere, VOR dieser Funktion importierte Einträge haben keine importBatchId und
  // tauchen hier deshalb nicht auf (können aber weiterhin einzeln gelöscht werden).
  const importBatches = useMemo(() => {
    const map = new Map();
    let dexCount = 0;
    for (const p of purchases) {
      if (p.source === 'dex' && !p.importBatchId) {
        dexCount++;
        continue;
      }
      if (!p.importBatchId) continue;
      if (!map.has(p.importBatchId)) {
        map.set(p.importBatchId, {
          id: p.importBatchId,
          fileName: p.importFileName || t('purchaseSourceCsv', lang),
          count: 0
        });
      }
      map.get(p.importBatchId).count++;
    }
    const result = [...map.values()];
    // Automatisch übernommene DEX-Käufe haben keine Import-Datei/Batch-ID, sollen aber genauso
    // sichtbar und gesammelt löschbar sein -- deshalb als eigener virtueller Eintrag ergänzt.
    if (dexCount > 0) {
      result.push({
        id: 'dex-buys',
        fileName: t('dexBuysBatchLabel', lang),
        count: dexCount,
        isDex: true
      });
    }
    return result;
  }, [purchases, lang]);
  const deleteImportBatch = batchId => {
    if (batchId === 'dex-buys') {
      setPurchases(prev => {
        const toDelete = prev.filter(p => p.source === 'dex' && !p.importBatchId);
        markDeleted(toDelete.map(p => p.id));
        return prev.filter(p => !(p.source === 'dex' && !p.importBatchId));
      });
      return;
    }
    setPurchases(prev => {
      const toDelete = prev.filter(p => p.importBatchId === batchId);
      markDeleted(toDelete.map(p => p.id));
      return prev.filter(p => p.importBatchId !== batchId);
    });
  };

  // --- Automatisch erkannte DEX/THORChain-Kauf-Vorschläge ---
  // Durchsucht die Swap-Historie aller aktuell getrackten Wallets (über dieselbe Midgard-API,
  // die die App schon für Bond/Unbond-Daten nutzt) nach Swaps, bei denen RUNE das empfangene
  // Ziel-Asset war -- das sind On-Chain-"Käufe". CEX-Käufe bleiben davon unberührt, da sie auf
  // der Chain nicht sichtbar sind. Läuft NUR auf Knopfdruck (kein Auto-Fetch im Hintergrund),
  // da es potenziell viele Anfragen + eine RUNE-Preishistorie braucht.
  const [suggestedPurchases, setSuggestedPurchases] = useState([]);
  const [suggestedPurchasesLoading, setSuggestedPurchasesLoading] = useState(false);
  const [suggestedPurchasesError, setSuggestedPurchasesError] = useState(null);
  const [dismissedSwapTxIds, setDismissedSwapTxIds] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_dismissed_swap_txids');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_dismissed_swap_txids', JSON.stringify(dismissedSwapTxIds.slice(-500)));
    } catch (e) {}
  }, [dismissedSwapTxIds]);

  // Ob bei der Suche zusätzlich zu echten On-Chain-Swaps auch reine Wallet-Eingänge (z.B.
  // CEX-Auszahlungen, die als schlichter Bank-Transfer ohne Swap ankommen) vorgeschlagen werden
  // sollen -- läuft jetzt als komplett eigener, separater Abschnitt (siehe fetchApproxTransferSuggestions
  // weiter unten), NICHT mehr vermischt mit den echten Swap-Vorschlägen, damit für den Nutzer klar
  // getrennt bleibt, was ein exakter und was ein nur geschätzter Kaufpreis ist.

  // Zusätzliche Adressen NUR für die DEX-Kauf-Suche (nicht für Portfolio-Balance/Bonded) --
  // im Gegensatz zu den normal getrackten Wallets (oben, streng thor1-Format) hier bewusst OHNE
  // Format-Prüfung, damit auch Absende-Adressen anderer Chains (BTC, ETH, ...) eingetragen
  // werden können, über die ein Swap gelaufen sein könnte, dessen RUNE-Ziel keine der aktuell
  // getrackten thor1-Wallets ist.
  const [extraSearchAddresses, setExtraSearchAddresses] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_extra_search_addresses');
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_extra_search_addresses', JSON.stringify(extraSearchAddresses));
    } catch (e) {}
  }, [extraSearchAddresses]);
  const [extraSearchAddressInput, setExtraSearchAddressInput] = useState('');
  const [extraAddressPanelOpen, setExtraAddressPanelOpen] = useState(false);
  const addExtraSearchAddress = () => {
    const clean = extraSearchAddressInput.trim();
    if (!clean) return;
    setExtraSearchAddresses(prev => prev.includes(clean) ? prev : [...prev, clean]);
    setExtraSearchAddressInput('');
  };
  const removeExtraSearchAddress = a => setExtraSearchAddresses(prev => prev.filter(x => x !== a));

  // --- Reine Wallet-Eingänge (z.B. CEX-Auszahlungen) als "geschätzte" Kauf-Vorschläge ---
  // Anders als ein On-Chain-Swap (bei dem die Herkunft/der Zweck über Midgard eindeutig als
  // "Swap" erkennbar ist) ist ein simpler Bank-Transfer auf eine thor1-Adresse erstmal nur ein
  // Eingang -- er kann ein CEX-Withdrawal sein (das WÄRE ein Kauf, dessen echter Preis nicht
  // rekonstruierbar ist), aber genauso ein Transfer von einer eigenen anderen Wallet, ein
  // Geschenk, eine Rückzahlung usw. Deshalb wird hier NICHT automatisch übernommen, sondern nur
  // als Vorschlag mit deutlich sichtbarer "≈ geschätzt"-Markierung angeboten (siehe UI), und
  // Sender-Adressen, die selbst zu den getrackten/zusätzlichen Such-Adressen gehören, werden von
  // vornherein ausgeschlossen (das sind mit hoher Sicherheit reine Wallet-zu-Wallet-Umbuchungen,
  // kein Zukauf).
  // Nutzt dieselben THORNode-Fallback-Basen wie fetchAllNodes (fetchThorchainApiWithFallback),
  // fragt den Cosmos-SDK-Tx-Suchendpunkt nach eingehenden "transfer"-Events pro Adresse ab.
  const isValidThorAddressLike = a => /^thor1[0-9a-z]{20,60}$/.test(String(a || ''));

  // Eigener, komplett getrennter State für den "Ungefähr"-Abschnitt (Wallet-Eingänge) -- läuft
  // unabhängig von den "Genau"-Swap-Vorschlägen (suggestedPurchases), damit beide Listen nie
  // vermischt angezeigt werden.
  const [suggestedTransfers, setSuggestedTransfers] = useState([]);
  const [suggestedTransfersLoading, setSuggestedTransfersLoading] = useState(false);
  const [suggestedTransfersError, setSuggestedTransfersError] = useState(null);

  const fetchNativeRuneTransfersIn = async (address, ownAddresses) => {
    const found = [];
    const PAGE_LIMIT = 100;
    const MAX_PAGES = 30; // bis zu 3000 Transfers pro Adresse
    const filter = `transfer.recipient='${address}'`;

    // WICHTIG: Der Cosmos-SDK-Parameter für die Tx-Suche hat sich geändert -- bis v0.47 hieß er
    // "events=", danach "query=" (der alte gilt als deprecated und wird von neueren Nodes teils
    // gar nicht mehr akzeptiert). THORChain läuft auf einer neueren SDK-Version, weshalb die
    // Abfrage mit "events=" still fehlschlug und die Suche IMMER "keine Wallet-Eingänge
    // gefunden" meldete -- auch wenn es welche gab. Deshalb zuerst "query=" probieren und nur
    // bei Ablehnung auf "events=" zurückfallen (ältere/abweichende Nodes im Fallback-Pool).
    // Ebenso: "pagination.limit/offset" ist post-0.46 deprecated, "page"/"limit" ist der
    // aktuelle Weg.
    const buildUrl = (paramName, page) => `/cosmos/tx/v1beta1/txs?${paramName}=${encodeURIComponent(filter)}&order_by=ORDER_BY_ASC&limit=${PAGE_LIMIT}&page=${page}`;

    let paramName = null;
    for (const candidate of ['query', 'events']) {
      try {
        const probe = await fetchThorchainApiWithFallback(buildUrl(candidate, 1));
        if (probe.ok) {
          paramName = candidate;
          break;
        }
      } catch (e) {/* nächsten Parameternamen probieren */}
    }
    if (!paramName) return found; // keine der beiden Varianten wird unterstützt

    for (let page = 1; page <= MAX_PAGES; page++) {
      let res;
      try {
        res = await fetchThorchainApiWithFallback(buildUrl(paramName, page));
      } catch (e) {
        break; // kein harter Fehler für die gesamte Suche -- Transfers bleiben dann einfach leer
      }
      if (!res.ok) break;
      let body;
      try {
        body = await res.json();
      } catch (e) {
        break;
      }
      const txResponses = body?.tx_responses || [];
      if (!txResponses.length) break;
      for (const txr of txResponses) {
        if (txr.code) continue; // fehlgeschlagene Tx überspringen
        const timestampMs = txr.timestamp ? Date.parse(txr.timestamp) : NaN;
        if (!Number.isFinite(timestampMs)) continue;
        const events = (txr.logs || []).flatMap(l => l.events || []);
        // Zusätzlich auch txr.events (neuere Cosmos-SDK-Antwortform) durchsuchen, falls logs leer.
        const allEvents = events.length ? events : txr.events || [];
        let runeAmountBase = 0;
        let senderIsOwn = false;
        let sawRecipientMatch = false;
        for (const ev of allEvents) {
          if (ev.type !== 'transfer') continue;
          const attrs = ev.attributes || [];
          // Cosmos-SDK gruppiert recipient/sender/amount als gleich-indizierte Attribut-Tripel
          // innerhalb desselben "transfer"-Events (mehrere Transfers pro Event möglich).
          for (let i = 0; i < attrs.length; i++) {
            if (attrs[i].key !== 'recipient') continue;
            const recipientVal = attrs[i].value;
            const senderVal = attrs[i + 1] && attrs[i + 1].key === 'sender' ? attrs[i + 1].value : null;
            const amountVal = attrs[i + 2] && attrs[i + 2].key === 'amount' ? attrs[i + 2].value : null;
            if (recipientVal !== address || !amountVal) continue;
            sawRecipientMatch = true;
            if (senderVal && ownAddresses.has(senderVal)) senderIsOwn = true;
            // amountVal Format z.B. "12345670000rune" oder mehrere Denoms kommagetrennt.
            for (const part of amountVal.split(',')) {
              const m = /^(\d+)rune$/.exec(part.trim());
              if (m) runeAmountBase += parseInt(m[1], 10);
            }
          }
        }
        if (!sawRecipientMatch || runeAmountBase <= 0 || senderIsOwn) continue;
        found.push({
          txId: txr.txhash,
          dateMs: timestampMs,
          runeAmount: runeAmountBase / 1e8
        });
      }
      if (txResponses.length < PAGE_LIMIT) break;
    }
    return found;
  };

  // ---- Sektion "GENAU": echte On-Chain-Swaps (RUNE als Zielasset) ----
  const fetchExactSwapSuggestions = async () => {
    const normalizeSearchAddress = a => /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
    const searchAddresses = [...new Set([...wallets, ...extraSearchAddresses].map(normalizeSearchAddress))];
    if (!searchAddresses.length) {
      setSuggestedPurchasesError(t('noWalletsForSuggestions', lang));
      return;
    }
    setSuggestedPurchasesLoading(true);
    setSuggestedPurchasesError(null);
    try {
      const knownTxIds = new Set([...purchases.map(p => p.txId).filter(Boolean), ...dismissedSwapTxIds]);
      const bases = ['https://gateway.liquify.com/chain/thorchain_midgard/v2', 'https://midgard.thorchain.network/v2'];
      // Bis zu 100 Seiten à 50 Einträge (=5000 Aktionen) pro Adresse UND Quelle -- deutlich mehr
      // als vorher (12 Seiten/600), damit auch Wallets mit langer Swap-Historie vollständig
      // erfasst werden.
      const MAX_SWAP_PAGES = 100;
      const foundSwapsById = new Map();
      for (const addr of searchAddresses) {
        // WICHTIG: beide Basis-URLs werden durchsucht und die Treffer ZUSAMMENGEFÜHRT (nicht nur
        // die erste, die ohne technischen Fehler antwortet) -- eine einzelne Quelle kann bei
        // einer bestimmten Adresse lückenhaft/im Rückstand sein, obwohl sie kein HTTP-Fehler
        // zurückgibt. Duplikate werden über die Transaktions-ID automatisch aussortiert.
        for (const base of bases) {
          // Manche Midgard-Versionen erwarten "type=", andere "txType=" -- beide probieren,
          // genau wie beim bestehenden Bond/Unbond-Fetch weiter oben in dieser Datei.
          for (const paramName of ['type', 'txType']) {
            let offset = 0;
            let pages = 0;
            let matchedAny = false;
            while (pages < MAX_SWAP_PAGES) {
              const url = `${base}/actions?address=${addr}&${paramName}=swap&limit=50&offset=${offset}`;
              let res;
              try {
                res = await thorchainFetch(url, {
                  headers: {
                    'x-client-id': 'rune-portfolio-app'
                  }
                });
              } catch (e) {
                break;
              }
              if (!res.ok) break;
              const json = await res.json();
              const actions = json.actions || [];
              if (actions.length === 0) break;
              for (const a of actions) {
                if (a.type !== 'swap' || a.status !== 'success') continue;
                matchedAny = true;
                // Affiliate-Gebühren-Leg über das von THORChain direkt mitgelieferte
                // "affiliate": true Flag ausschließen (zuverlässiges offizielles Signal) --
                // der vorherige Versuch verglich metadata.swap.affiliateAddress (oft nur ein
                // kurzer THORName-Alias wie "vi") mit der aufgelösten Empfänger-Adresse, was nie
                // übereinstimmte und die Affiliate-Gebühr fälschlich mitzählte.
                const inGroups = (a.in || []).filter(g => !g.affiliate);
                const outGroups = (a.out || []).filter(g => !g.affiliate);
                const inCoins = inGroups.flatMap(g => g.coins || []);
                const outCoins = outGroups.flatMap(g => g.coins || []);
                const inHasRune = inCoins.some(c => c.asset === 'THOR.RUNE');
                const outRuneCoins = outCoins.filter(c => c.asset === 'THOR.RUNE');
                if (inHasRune || !outRuneCoins.length) continue; // nur "RUNE rein" zählt als Kauf
                const runeAmount = outRuneCoins.reduce((sum, c) => sum + (parseInt(c.amount, 10) || 0), 0) / 1e8;
                if (runeAmount <= 0) continue;
                const txId = a.in && a.in[0] && a.in[0].txID || `${addr}-${a.date}`;
                if (knownTxIds.has(txId)) continue;
                const dateMs = a.date ? Math.floor(parseInt(a.date, 10) / 1e6) : null;
                if (!dateMs) continue;
                // WICHTIG: Streaming-Swaps (THORChain teilt große Swaps automatisch in viele
                // Teil-Swaps auf) können als MEHRERE Aktionen mit derselben Transaktions-ID
                // auftauchen. Vorher wurde bei doppelter ID die Aktion einfach übersprungen --
                // dadurch blieb nur der Betrag EINES Teil-Swaps übrig, statt der Summe aller
                // Teil-Swaps (z.B. 6,55 statt tatsächlich 1.303,47 RUNE). Jetzt wird bei
                // gleicher ID aufaddiert, das früheste Datum aber beibehalten.
                const existing = foundSwapsById.get(txId);
                if (existing) {
                  existing.runeAmount += runeAmount;
                  if (dateMs < existing.dateMs) existing.dateMs = dateMs;
                } else {
                  foundSwapsById.set(txId, {
                    txId,
                    dateMs,
                    runeAmount,
                    inputAsset: inCoins[0] && inCoins[0].asset || null,
                    method: 'swap'
                  });
                }
              }
              if (actions.length < 50) break;
              offset += 50;
              pages++;
            }
            // Hat diese Basis-URL mit "type=" schon Treffer geliefert, muss "txType=" nicht auch
            // noch probiert werden (wäre nur eine redundante zweite Abfrage derselben Daten).
            if (matchedAny) break;
          }
        }
      }
      const foundSwaps = [...foundSwapsById.values()];
      if (!foundSwaps.length) {
        setSuggestedPurchases([]);
        setSuggestedPurchasesError(t('noNewSwapsFound', lang));
        return;
      }
      // Näherungsweiser RUNE/USD-Preis zum jeweiligen Swap-Zeitpunkt: statt EINER groben
      // 3-Jahres-Kursreihe (3-Tage-Kerzen, die an einem einzelnen Tag bei einem volatilen Coin
      // ziemlich daneben liegen kann) wird jetzt für jeden Tag, an dem tatsächlich ein Swap
      // stattfand, gezielt eine STÜNDLICHE Kursreihe abgefragt -- deutlich genauer, und durch
      // das Gruppieren nach Tag bleibt die Anzahl der Anfragen trotzdem klein (ein Fetch pro
      // Tag, nicht pro Swap).
      const uniqueDayKeys = [...new Set(foundSwaps.map(s => Math.floor(s.dateMs / 86400000)))].slice(0, 90);
      const dayPriceCache = new Map();
      for (const dayKey of uniqueDayKeys) {
        const dayStartMs = dayKey * 86400000;
        const dayEndMs = dayStartMs + 86400000;
        try {
          const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=RUNEUSDT&interval=1h&startTime=${dayStartMs}&endTime=${dayEndMs}&limit=24`);
          if (res.ok) {
            const raw = await res.json();
            const points = raw.map(k => ({
              date: k[0],
              value: parseFloat(k[4])
            })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
            if (points.length) dayPriceCache.set(dayKey, points);
          }
        } catch (e) {/* dieser Tag bleibt ohne Preis, Swap wird unten aussortiert */}
      }
      const findNearestPrice = dateMs => {
        const dayKey = Math.floor(dateMs / 86400000);
        const points = dayPriceCache.get(dayKey);
        if (!points || !points.length) return null;
        let best = points[0];
        let bestDiff = Math.abs(points[0].date - dateMs);
        for (const p of points) {
          const diff = Math.abs(p.date - dateMs);
          if (diff < bestDiff) {
            best = p;
            bestDiff = diff;
          }
        }
        return best.value;
      };
      const suggestions = foundSwaps.map(s => ({
        ...s,
        priceUsd: findNearestPrice(s.dateMs)
      })).filter(s => Number.isFinite(s.priceUsd) && s.priceUsd > 0).sort((a, b) => b.dateMs - a.dateMs);
      setSuggestedPurchases(suggestions);
      if (!suggestions.length) setSuggestedPurchasesError(t('noNewSwapsFound', lang));
    } catch (e) {
      setSuggestedPurchasesError(t('suggestionsFetchFailed', lang));
    } finally {
      setSuggestedPurchasesLoading(false);
    }
  };
  const acceptSuggestion = s => {
    addOrUpdatePurchase({
      id: null,
      date: s.dateMs,
      amount: s.runeAmount,
      priceUsd: s.priceUsd,
      type: 'buy',
      source: 'dex',
      txId: s.txId,
      priceSource: 'swap'
    });
    setSuggestedPurchases(prev => prev.filter(x => x.txId !== s.txId));
  };
  const dismissSuggestion = s => {
    setDismissedSwapTxIds(prev => [...prev, s.txId]);
    setSuggestedPurchases(prev => prev.filter(x => x.txId !== s.txId));
  };

  // ---- Sektion "UNGEFÄHR": reine Wallet-Eingänge (z.B. CEX-Auszahlungen) ----
  // Komplett unabhängig von fetchExactSwapSuggestions -- eigener Button, eigene Liste, eigener
  // Ladezustand. Wird bewusst NICHT automatisch mitgesucht und NICHT in dieselbe Liste gemischt,
  // damit für den Nutzer immer eindeutig ist, ob ein Vorschlag einen exakten oder nur einen
  // geschätzten Preis hat.
  const fetchApproxTransferSuggestions = async () => {
    const normalizeSearchAddress = a => /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;
    const searchAddresses = [...new Set([...wallets, ...extraSearchAddresses].map(normalizeSearchAddress))];
    const thorSearchAddresses = searchAddresses.filter(a => isValidThorAddressLike(a));
    if (!thorSearchAddresses.length) {
      setSuggestedTransfersError(t('noWalletsForSuggestions', lang));
      return;
    }
    setSuggestedTransfersLoading(true);
    setSuggestedTransfersError(null);
    try {
      const knownTxIds = new Set([...purchases.map(p => p.txId).filter(Boolean), ...dismissedSwapTxIds]);
      const ownAddresses = new Set(searchAddresses);
      let foundTransfers = [];
      for (const addr of thorSearchAddresses) {
        try {
          const transfers = await fetchNativeRuneTransfersIn(addr, ownAddresses);
          foundTransfers.push(...transfers);
        } catch (e) {/* eine fehlgeschlagene Adresse darf die restliche Suche nicht abbrechen */}
      }
      // Dedupe über txId, und gegen bereits bekannte/verworfene IDs.
      const seenTransferIds = new Set();
      foundTransfers = foundTransfers.filter(tr => {
        if (knownTxIds.has(tr.txId) || seenTransferIds.has(tr.txId)) return false;
        seenTransferIds.add(tr.txId);
        return true;
      });
      // WICHTIG: der RUNE-Auszahlungs-"Leg" eines nativen Swaps ist selbst auch ein ganz
      // normaler Bank-Transfer und würde hier sonst ZUSÄTZLICH zu einem bereits im "Genau"-
      // Abschnitt angezeigten (aber noch nicht übernommenen) Swap auftauchen. Deshalb: jeder
      // Transfer, der zeitlich sehr nah (< 5 Min) an einem aktuell angezeigten Swap-Vorschlag
      // liegt UND eine sehr ähnliche RUNE-Menge hat (< 0.5% Abweichung), wird verworfen statt
      // doppelt vorgeschlagen. Deckt nur den Fall ab, dass die "Genau"-Suche vorher/parallel in
      // derselben Sitzung schon gelaufen ist -- ein zusätzlicher, unabhängiger Check.
      foundTransfers = foundTransfers.filter(tr => !suggestedPurchases.some(sw => Math.abs(sw.dateMs - tr.dateMs) < 5 * 60 * 1000 && Math.abs(sw.runeAmount - tr.runeAmount) / Math.max(sw.runeAmount, tr.runeAmount) < 0.005));
      foundTransfers = foundTransfers.map(tr => ({
        ...tr,
        method: 'transfer'
      }));
      if (!foundTransfers.length) {
        setSuggestedTransfers([]);
        setSuggestedTransfersError(t('noNewTransfersFound', lang));
        return;
      }
      // Gleicher stündlicher Kurs-Lookup wie bei den Swaps -- hier aber explizit nur eine
      // SCHÄTZUNG (Marktpreis zum Ankunftszeitpunkt, nicht der tatsächlich auf der Börse
      // gezahlte Preis), siehe "≈"-Kennzeichnung in der UI.
      const uniqueDayKeys = [...new Set(foundTransfers.map(s => Math.floor(s.dateMs / 86400000)))].slice(0, 90);
      const dayPriceCache = new Map();
      for (const dayKey of uniqueDayKeys) {
        const dayStartMs = dayKey * 86400000;
        const dayEndMs = dayStartMs + 86400000;
        try {
          const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=RUNEUSDT&interval=1h&startTime=${dayStartMs}&endTime=${dayEndMs}&limit=24`);
          if (res.ok) {
            const raw = await res.json();
            const points = raw.map(k => ({
              date: k[0],
              value: parseFloat(k[4])
            })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
            if (points.length) dayPriceCache.set(dayKey, points);
          }
        } catch (e) {/* dieser Tag bleibt ohne Preis, Eintrag wird unten aussortiert */}
      }
      const findNearestPrice = dateMs => {
        const dayKey = Math.floor(dateMs / 86400000);
        const points = dayPriceCache.get(dayKey);
        if (!points || !points.length) return null;
        let best = points[0];
        let bestDiff = Math.abs(points[0].date - dateMs);
        for (const p of points) {
          const diff = Math.abs(p.date - dateMs);
          if (diff < bestDiff) {
            best = p;
            bestDiff = diff;
          }
        }
        return best.value;
      };
      const suggestions = foundTransfers.map(s => ({
        ...s,
        priceUsd: findNearestPrice(s.dateMs)
      })).filter(s => Number.isFinite(s.priceUsd) && s.priceUsd > 0).sort((a, b) => b.dateMs - a.dateMs);
      setSuggestedTransfers(suggestions);
      if (!suggestions.length) setSuggestedTransfersError(t('noNewTransfersFound', lang));
    } catch (e) {
      setSuggestedTransfersError(t('suggestionsFetchFailed', lang));
    } finally {
      setSuggestedTransfersLoading(false);
    }
  };
  const acceptTransferSuggestion = s => {
    addOrUpdatePurchase({
      id: null,
      date: s.dateMs,
      amount: s.runeAmount,
      priceUsd: s.priceUsd,
      type: 'buy',
      source: 'other',
      txId: s.txId,
      // 'estimated' markiert Käufe, deren Preis nur der Marktpreis zum Ankunftszeitpunkt ist
      // (reiner Wallet-Eingang, kein Swap) -- wird in der Kaufliste mit "≈" gekennzeichnet.
      priceSource: 'estimated'
    });
    setSuggestedTransfers(prev => prev.filter(x => x.txId !== s.txId));
  };
  const dismissTransferSuggestion = s => {
    setDismissedSwapTxIds(prev => [...prev, s.txId]);
    setSuggestedTransfers(prev => prev.filter(x => x.txId !== s.txId));
  };

  // --- Node-Statistik (netzwerkweit: aktiv / wollen rein / wollen raus) ---
  const [nodeChurnStats, setNodeChurnStats] = useState(null);
  const [nodeChurnError, setNodeChurnError] = useState(null);

  // --- In-App-Benachrichtigungen für die eigenen (in `wallets` getrackten) Nodes ---
  // nodeWatchNotifications: Verlauf der Statusänderungen für Nodes, an denen eine der
  // eigenen Wallet-Adressen als Bond Provider hängt. Persistiert in localStorage, damit
  // der Verlauf auch nach Neuladen der Seite erhalten bleibt.
  const [nodeWatchNotifications, setNodeWatchNotifications] = useState(() => {
    try {
      const raw = localStorage.getItem('tp_node_notifications');
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_node_notifications', JSON.stringify(nodeWatchNotifications.slice(0, 50)));
    } catch (e) {}
  }, [nodeWatchNotifications]);
  const [nodeBellOpen, setNodeBellOpen] = useState(false);
  const nodeWatchUnreadCount = nodeWatchNotifications.filter(n => !n.read).length;

  // Holt periodisch die komplette Node-Liste, berechnet die Netzwerk-Statistik UND
  // vergleicht die Nodes der eigenen Wallets mit dem zuletzt bekannten Stand
  // (localStorage), um bei Statusänderungen eine Benachrichtigung zu erzeugen.
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const nodes = await fetchAllNodes();
        if (cancelled || !Array.isArray(nodes)) return;
        const stats = computeNodeChurnStats(nodes);
        setNodeChurnStats(stats);
        setNodeChurnError(null);

        // Welche Nodes sind für die eigenen Wallet-Adressen relevant (als Bond Provider)?
        const walletSet = new Set(wallets.map(w => w.toLowerCase()));
        if (walletSet.size === 0) return;
        let snapshot = {};
        try {
          snapshot = JSON.parse(localStorage.getItem('tp_node_watch_snapshot') || '{}');
        } catch (e) {
          snapshot = {};
        }
        const activeNodes = nodes.filter(n => n.status === 'Active');
        const newEvents = [];
        const newSnapshot = {
          ...snapshot
        };
        for (const node of nodes) {
          const providers = node.bond_providers?.providers || [];
          const isMine = providers.some(p => walletSet.has((p.bond_address || '').toLowerCase()));
          if (!isMine) continue;
          const leaveInfo = getNodeLeaveInfo(node, activeNodes);
          const current = {
            status: node.status,
            requestedToLeave: !!node.requested_to_leave,
            leaveType: leaveInfo?.type || null
          };
          const prev = snapshot[node.node_address];
          const shortAddr = node.node_address.slice(0, 8) + '…' + node.node_address.slice(-5);
          if (prev) {
            const you = t('nodeYourNode', lang);
            if (current.status === 'Active' && prev.status !== 'Active') {
              newEvents.push({
                nodeAddress: node.node_address,
                message: `${you} ${shortAddr} ${t('nodeNowActive', lang)}`,
                variant: 'success'
              });
            }
            if (prev.status === 'Active' && current.status !== 'Active') {
              newEvents.push({
                nodeAddress: node.node_address,
                message: `${you} ${shortAddr} ${t('nodeLeftActiveSet', lang)}`,
                variant: 'warning'
              });
            }
            if (current.requestedToLeave && !prev.requestedToLeave) {
              newEvents.push({
                nodeAddress: node.node_address,
                message: `${you} ${shortAddr} ${t('nodeLeaveRequested', lang)}`,
                variant: 'warning'
              });
            }
            // "leaving" wird schon oben über requestedToLeave gemeldet -- hier nicht nochmal doppelt anzeigen.
            if (current.leaveType && current.leaveType !== 'leaving' && current.leaveType !== prev.leaveType) {
              const reasonKey = {
                forced: 'nodeLeaveTypeForced',
                oldest: 'nodeLeaveTypeOldest',
                worst: 'nodeLeaveTypeWorst',
                lowest: 'nodeLeaveTypeLowest'
              }[current.leaveType];
              newEvents.push({
                nodeAddress: node.node_address,
                message: `${you} ${shortAddr} ${t('nodeChurnOutCandidate', lang)} (${t(reasonKey, lang)})`,
                variant: 'warning'
              });
            }
          }
          newSnapshot[node.node_address] = current;
        }
        try {
          localStorage.setItem('tp_node_watch_snapshot', JSON.stringify(newSnapshot));
        } catch (e) {}
        if (newEvents.length > 0 && !cancelled) {
          setNodeWatchNotifications(prevList => [...newEvents.map(ev => ({
            id: ev.nodeAddress + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
            timestamp: Date.now(),
            read: false,
            ...ev
          })), ...prevList].slice(0, 50));
        }
      } catch (e) {
        if (!cancelled) setNodeChurnError(e.message || 'NODES_FETCH_FAILED');
      }
    };
    poll();
    const interval = setInterval(poll, 60000); // alle 60 Sekunden erneut prüfen
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [wallets, lang]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [autoRetryPending, setAutoRetryPending] = useState(false); // zeigt "wird automatisch erneut versucht" im Fehler-Banner
  const [balance, setBalance] = useState(null);
  const [bonded, setBonded] = useState(null);
  const [accruedForPortfolio, setAccruedForPortfolio] = useState(null); // atomar zusammen mit bonded ermittelt, siehe fetchPortfolio -- NICHT dasselbe wie die separate, für die "Next Reward"-Anzeige/Live-Ticker genutzte accruedAwardSum
  const [nodeBreakdown, setNodeBreakdown] = useState([]); // [{ nodeAddress, status, bonded }] — welcher Node wie viel hält
  const [nodeBreakdownExpanded, setNodeBreakdownExpanded] = useState(false);
  // Hält die zuletzt bekannten Werte per Ref fest (nicht nur per State), damit
  // fetchPortfolio auch bei mehrfachem Aufruf (Refresh-Button) immer den *aktuellen* Wert
  // sieht und nicht einen veralteten aus dem Zeitpunkt, als die Funktion erstellt wurde.
  // Hält den zuletzt bekannten Bonded-/Balance-Wert PRO Adresse fest (nicht nur global), damit
  // der Lag-Erkennungs-Schutz (siehe fetchPortfolio) für jede Wallet unabhängig funktioniert,
  // auch wenn mehrere Wallets gleichzeitig getrackt werden.
  const bondedByAddrRef = useRef({}); // letzter bekannter Wert je Adresse (nur als Fallback, falls ein Abruf mal fehlschlägt)
  const balanceByAddrRef = useRef({});
  const [price, setPrice] = useState(null);
  const [altPrice, setAltPrice] = useState(null); // Preis des in priceRowBox gewählten Vergleichs-Coins
  // Wird gesetzt, wenn Preis-/Chart-Daten bei einem Refresh nicht geladen werden konnten
  // (z.B. Rate-Limit bei CoinGecko/Binance). Die App zeigt dann weiterhin die zuletzt bekannten
  // Preise/den zuletzt bekannten Chart an (statt alles zu verwerfen) und blendet nur einen
  // dezenten Hinweis ein -- Balance/Bonded hängen NICHT von den Preisdaten ab.
  const [priceWarning, setPriceWarning] = useState(null);
  // Welcher Coin neben RUNE angezeigt wird (Standard: BTC) — lokal gemerkt.
  const [altCoinCode, setAltCoinCode] = useState(() => {
    try {
      return localStorage.getItem('tp_alt_coin') || 'BTC';
    } catch (e) {
      return 'BTC';
    }
  });
  const altCoin = ALT_COIN_OPTIONS.find(c => c.code === altCoinCode) || ALT_COIN_OPTIONS[0];
  const [altCoinPickerOpen, setAltCoinPickerOpen] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem('tp_alt_coin', altCoinCode);
    } catch (e) {}
  }, [altCoinCode]);
  const [history, setHistory] = useState([]);
  const [range, setRange] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem('tp_portfolio_range'), 10);
      return RANGES.some(r => r.days === saved) ? saved : 7;
    } catch (e) {
      return 7;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_portfolio_range', String(range));
    } catch (e) {}
  }, [range]);
  const [rangePickerOpen, setRangePickerOpen] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [hideValue, setHideValue] = useState(false);
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [currency, setCurrency] = useState(() => {
    try {
      return localStorage.getItem('tp_currency') || 'usd';
    } catch (e) {
      return 'usd';
    }
  });
  const [currencyPickerOpen, setCurrencyPickerOpen] = useState(false);
  const [volume24h, setVolume24h] = useState(null); // RUNE-Menge, netzwerkweit
  const [volumeHistory, setVolumeHistory] = useState(null); // [{ t, volumeRune }] letzte 30 Tage
  // Zwei "Seiten" auf dem Handy (Chart / Details), damit man nicht mehr scrollen muss --
  // per Tab-Button oder Wischgeste wechselbar. Auf dem Desktop bleibt alles nebeneinander
  // sichtbar (siehe .tp-panel Regeln im <style>-Block).
  const [mobileTab, setMobileTab] = useState('chart'); // 'chart' | 'details'
  const swipeStartRef = useRef(null);
  const handleContentTouchStart = e => {
    swipeStartRef.current = {
      x: e.touches[0].clientX,
      y: e.touches[0].clientY
    };
  };
  const handleContentTouchEnd = e => {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return; // zu kurz oder eher vertikal -> ignorieren
    if (dx < 0) setMobileTab('details'); // nach links wischen -> Details
    else setMobileTab('chart'); // nach rechts wischen -> Chart
  };

  // Vollständige tägliche RUNE-Preishistorie (seit Listing) — ein einziger Abruf pro Basis, um
  // jedem historischen Reward-Eintrag den damaligen Preis zuordnen zu können, statt für jeden
  // der ~160 Einträge einzeln nachzufragen. USD wird EINMAL geholt und für jede Währung
  // wiederverwendet; die "lokale" Serie (in der gewählten Währung) wird pro Währungscode
  // separat gecacht, damit ein Wechsel zwischen Währungen nicht ständig neu abfragt.
  const [priceHistoryFull, setPriceHistoryFull] = useState(null); // { usd: [[tsMs, price], ...], local: [...] }
  const usdHistoryRef = useRef(null);
  const usdHistoryPromiseRef = useRef(null);
  const localHistoryCacheRef = useRef({}); // currencyCode -> [[tsMs, price], ...]
  const localHistoryPromiseCacheRef = useRef({});
  const fetchUsdHistoryOnce = useCallback(async () => {
    if (usdHistoryRef.current) return usdHistoryRef.current;
    if (usdHistoryPromiseRef.current) return usdHistoryPromiseRef.current;
    const promise = (async () => {
      // Primär: Binance — großzügiges Rate-Limit, wird ohnehin für den Live-Preis genutzt.
      try {
        const runeRes = await fetchWithTimeout('https://api.binance.com/api/v3/klines?symbol=RUNEUSDT&interval=1d&limit=1000');
        if (!runeRes.ok) throw new Error('BINANCE_HIST_FAIL');
        const runeKlines = await runeRes.json();
        if (!Array.isArray(runeKlines) || runeKlines.length === 0) throw new Error('BINANCE_HIST_EMPTY');
        const usd = runeKlines.map(k => [k[0], parseFloat(k[4])]);
        usdHistoryRef.current = usd;
        return usd;
      } catch (binanceErr) {
        console.warn('[RUNE Portfolio] Binance-USD-Historie fehlgeschlagen, weiche auf CoinGecko aus:', binanceErr);
      }
      // Fallback: CoinGecko, mit Retry falls kurzzeitig rate-limitiert.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/coins/thorchain/market_chart?vs_currency=usd&days=max&interval=daily');
          if (!res.ok) throw new Error('CHART_FAIL_' + res.status);
          const json = await res.json();
          const usd = json.prices || [];
          usdHistoryRef.current = usd;
          return usd;
        } catch (e) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          console.warn('[RUNE Portfolio] USD-Preishistorie konnte nicht geladen werden:', e);
          return null;
        }
      }
      return null;
    })();
    usdHistoryPromiseRef.current = promise;
    try {
      return await promise;
    } finally {
      usdHistoryPromiseRef.current = null;
    }
  }, []);
  const fetchPriceHistoryFullOnce = useCallback(async targetCurrency => {
    const cur = (targetCurrency || 'usd').toLowerCase();
    const usd = await fetchUsdHistoryOnce();
    if (!usd) return null;
    if (cur === 'usd') {
      const result = {
        usd,
        local: usd
      };
      setPriceHistoryFull(result);
      return result;
    }
    if (localHistoryCacheRef.current[cur]) {
      const result = {
        usd,
        local: localHistoryCacheRef.current[cur]
      };
      setPriceHistoryFull(result);
      return result;
    }
    if (localHistoryPromiseCacheRef.current[cur]) {
      const local = await localHistoryPromiseCacheRef.current[cur];
      const result = {
        usd,
        local: local || usd
      };
      setPriceHistoryFull(result);
      return result;
    }
    const promise = (async () => {
      // EUR: exakte tägliche Umrechnung über Binance EUR/USDT-Kerzen (schnell, zuverlässig).
      if (cur === 'eur') {
        try {
          const eurRes = await fetchWithTimeout('https://api.binance.com/api/v3/klines?symbol=EURUSDT&interval=1d&limit=1000');
          if (eurRes.ok) {
            const eurKlines = await eurRes.json();
            const eurByDay = new Map(eurKlines.map(k => [k[0], parseFloat(k[4])]));
            const local = usd.map(([ts, usdVal]) => {
              const eurUsdt = eurByDay.get(ts);
              return [ts, eurUsdt ? usdVal / eurUsdt : usdVal];
            });
            localHistoryCacheRef.current[cur] = local;
            return local;
          }
        } catch (e) {/* fällt auf CoinGecko zurück */}
      }
      // Nicht-EUR-Währungen (GBP, JPY, CHF, ...): primär eine schnelle, kostenlose FX-Kurs-API
      // (frankfurter.app, EZB-Referenzkurse, kein API-Key, kein Rate-Limit-Ärger) nutzen, um die
      // bereits vorhandene USD-Historie umzurechnen -- genau wie beim EUR-Pfad über Binance oben,
      // nur eben für Währungen ohne eigenes USDT-Paar. CoinGecko wird dadurch NIE mehr die primäre
      // Quelle für den Portfolio-Chart, sondern bleibt nur noch der allerletzte Fallback, falls
      // auch frankfurter.app mal ausfällt (siehe Schleife weiter unten).
      try {
        const toDateStr = ts => new Date(ts).toISOString().slice(0, 10);
        const firstDate = toDateStr(usd[0][0]);
        const lastDate = toDateStr(usd[usd.length - 1][0]);
        const fxRes = await fetchWithTimeout(`https://api.frankfurter.app/${firstDate}..${lastDate}?from=USD&to=${cur.toUpperCase()}`);
        if (fxRes.ok) {
          const fxJson = await fxRes.json();
          const rateEntries = Object.entries(fxJson.rates || {}).map(([d, r]) => [new Date(`${d}T00:00:00Z`).getTime(), r[cur.toUpperCase()]]).filter(([, r]) => r != null).sort((a, b) => a[0] - b[0]);
          if (rateEntries.length) {
            // EZB-Kurse gibt es nur an Bankarbeitstagen -- für Wochenenden/Feiertage (und für den
            // aktuellsten Tag, falls der Kurs von heute noch nicht vorliegt) den letzten bekannten
            // Kurs vor/an diesem Datum weiterverwenden (Forward-Fill).
            let ri = 0;
            const local = usd.map(([ts, usdVal]) => {
              while (ri + 1 < rateEntries.length && rateEntries[ri + 1][0] <= ts) ri++;
              const rate = rateEntries[ri][1];
              return [ts, usdVal * rate];
            });
            localHistoryCacheRef.current[cur] = local;
            return local;
          }
        }
      } catch (e) {/* fällt auf CoinGecko zurück */}
      // Alle anderen Währungen (und EUR-Fallback): direkt von CoinGecko in der Zielwährung.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/coins/thorchain/market_chart?vs_currency=${cur}&days=max&interval=daily`);
          if (!res.ok) throw new Error('CHART_FAIL_' + res.status);
          const json = await res.json();
          const local = json.prices || [];
          localHistoryCacheRef.current[cur] = local;
          return local;
        } catch (e) {
          if (attempt === 0) {
            await new Promise(r => setTimeout(r, 1500));
            continue;
          }
          console.warn(`[RUNE Portfolio] Preishistorie für ${cur} konnte nicht geladen werden:`, e);
          return null;
        }
      }
      return null;
    })();
    localHistoryPromiseCacheRef.current[cur] = promise;
    let local;
    try {
      local = await promise;
    } finally {
      delete localHistoryPromiseCacheRef.current[cur];
    }
    const result = {
      usd,
      local: local || usd
    };
    setPriceHistoryFull(result);
    return result;
  }, [fetchUsdHistoryOnce]);
  useEffect(() => {
    fetchPriceHistoryFullOnce(currency);
  }, [fetchPriceHistoryFullOnce, currency]);

  // Findet den nächstgelegenen (letzten bekannten) Preis vor oder an einem gegebenen Zeitpunkt.
  const findPriceAt = (series, tsMs) => {
    if (!series || series.length === 0) return null;
    let lo = 0,
      hi = series.length - 1,
      best = null;
    while (lo <= hi) {
      const mid = lo + hi >> 1;
      if (series[mid][0] <= tsMs) {
        best = series[mid][1];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best != null ? best : series[0][1];
  };

  // Live-Preis-Updates via wiederholtes Abfragen der Binance-REST-API (kein WebSocket mehr,
  // da wss:// in manchen Vorschau-/Sandbox-Umgebungen blockiert wird, fetch() aber zuverlässig
  // funktioniert). Aktualisiert Preis/Vergleichs-Coin-Preis jede Sekunde, ohne die Seite neu zu
  // laden. Für Währungen jenseits USD/EUR (kein direktes Binance-Paar) wird der USD-Preis
  // weiterhin sekündlich aktualisiert, aber mit einem separat, seltener (alle 60s über
  // CoinGecko) aufgefrischten Umrechnungskurs in die Zielwährung multipliziert — so bleibt die
  // Anzeige "live", ohne CoinGecko im Sekundentakt anzufragen (Rate-Limit).
  const [liveConnected, setLiveConnected] = useState(false);

  // Tägliche prozentuale Preisänderung (24h) für RUNE und den gewählten Vergleichs-Coin —
  // dezent neben dem Preis angezeigt. Läuft separat vom 1-Sekunden-Preis-Ticker (die 24h-
  // Änderung ändert sich langsam, dafür braucht's keinen Sekundentakt) und wird alle 60s
  // aufgefrischt, um API-Last gering zu halten.
  const [runeChange24h, setRuneChange24h] = useState(null);

  // Zeigt den aktuellen RUNE-Preis live im Browser-Tab-Titel an (z.B. "$1.234 ▲ · rune.watch"),
  // damit man den Kurs auch sieht, wenn der Tab im Hintergrund liegt / nicht aktiv ist.
  // Aktualisiert sich mit demselben Sekunden-Ticker wie die Preis-Kachel (price ändert sich
  // dort im gleichen Rhythmus); fällt auf den Standard-Titel zurück, solange noch kein Preis
  // geladen ist.
  useEffect(() => {
    if (!price) {
      document.title = 'rune.watch';
      return;
    }
    const val = currency === 'usd' ? price.usd : price.local;
    if (val == null) {
      document.title = 'rune.watch';
      return;
    }
    const priceLabel = fmtUSDPrecise(val, lang, currency);
    const arrow = runeChange24h == null ? '' : runeChange24h >= 0 ? ' ▲' : ' ▼';
    document.title = `rune.watch · ${priceLabel}${arrow}`;
  }, [price, currency, lang, runeChange24h]);
  // Einfacher RUNE-Preis-Chart (Übersicht, kein Zeichnen/Zoomen) — tippen auf die RUNE-Kachel
  // öffnet ihn. Bewusst schlank gehalten: ein einzelner Abruf pro Zeitraum, keine Pagination,
  // kein Zoom/Pan-Zustand — genau die Komplexität, die beim großen Kerzen-Chart für endlose
  // Probleme gesorgt hat, wird hier gar nicht erst eingeführt.
  const [showRunePriceChart, setShowRunePriceChart] = useState(false);
  // Welches Paar der RUNE-Preis-Chart zeigt: 'USD' (bzw. gewählte Fiat-Währung), 'BTC' oder
  // 'ETH' -- direkt von Binance über die jeweiligen RUNEBTC/RUNEETH-Handelspaare, nicht über
  // eine Umrechnung via USD (das wäre ungenauer, da beide Kurse dann getrennt schwanken).
  const [runeQuote, setRuneQuote] = useState('USD');
  const [runeQuotePickerOpen, setRuneQuotePickerOpen] = useState(false);
  const RUNE_QUOTE_OPTIONS = ['USD', 'BTC', 'ETH'];
  // Live-Ticker-Preis für RUNE/BTC bzw. RUNE/ETH (unabhängig vom Fiat-Live-Preis oben) --
  // wird nur benötigt/aktualisiert, solange runeQuote nicht 'USD' ist.
  const [runeQuoteLivePrice, setRuneQuoteLivePrice] = useState(null);
  const [runePriceRangeDays, setRunePriceRangeDays] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem('tp_rune_price_range'), 10);
      return RUNE_PRICE_CHART_RANGES.includes(saved) ? saved : 1;
    } catch (e) {
      return 1;
    }
  }); // 1 = täglich, 7 = wöchentlich, 30 = monatlich
  useEffect(() => {
    try {
      localStorage.setItem('tp_rune_price_range', String(runePriceRangeDays));
    } catch (e) {}
  }, [runePriceRangeDays]);
  // Der Zeitraum, der TATSÄCHLICH gerendert wird (bestimmt den `key` unten) -- bewusst getrennt
  // von runePriceRangeDays (dem vom Nutzer ANGEFRAGTEN Zeitraum). So bleibt beim Umschalten der
  // alte Chart mit seinen alten (aber immerhin stimmigen) Daten flüssig sichtbar, bis die neuen
  // Daten fertig geladen sind -- erst dann wird in einem einzigen Schritt umgeschaltet, statt
  // zwischendurch entweder ein Loading-Screen oder (schlimmer) ein kurz aufblitzender, mit den
  // FALSCHEN (alten) Daten neu gemounteter Chart zu zeigen.
  const [runePriceChartRangeDays, setRunePriceChartRangeDays] = useState(7);
  const [runePriceRangePickerOpen, setRunePriceRangePickerOpen] = useState(false);
  const [runePriceHistory, setRunePriceHistory] = useState([]);
  const [runePriceHistoryLoading, setRunePriceHistoryLoading] = useState(false);
  // WICHTIG: price/currency hier über Refs lesen, NICHT als Dependencies der useCallback
  // verwenden. price ändert sich jede Sekunde (Live-Ticker) — wäre es eine Dependency, würde
  // sich die Funktionsreferenz jede Sekunde ändern, was wiederum den "lade komplette Historie"
  // Effekt weiter unten jede Sekunde erneut auslösen würde (unnötiger Server-Traffic UND es
  // hätte die Live-Aktualisierung des letzten Punkts sofort wieder überschrieben, weil der
  // frische Fetch die per Live-Tick gesetzte Änderung zunichtemacht).
  const priceForConversionRef = useRef(price);
  useEffect(() => {
    priceForConversionRef.current = price;
  }, [price]);
  const currencyForConversionRef = useRef(currency);
  useEffect(() => {
    currencyForConversionRef.current = currency;
  }, [currency]);
  const runeQuoteRef = useRef(runeQuote);
  useEffect(() => {
    runeQuoteRef.current = runeQuote;
  }, [runeQuote]);
  const fetchRunePriceHistory = useCallback(async days => {
    // Absichtlich EIN einzelner Abruf, kein Pagination/Batch-Mechanismus wie beim früheren
    // Kerzen-Chart — für eine reine Übersicht reicht das, und es gibt schlicht keine Stelle,
    // an der sich ein fehlerhafter Zoom-/Fenster-Zustand aufbauen könnte. Bei 90 Tagen bzw.
    // 1-3 Jahren braucht es gröbere Kerzen, damit die Anfrage innerhalb von Binances Limit von
    // 1000 Kerzen pro Anfrage bleibt (3 Jahre täglich wären ~1095 Kerzen -- zu viele, deshalb
    // 3-Tages-Kerzen für den 3-Jahres-Zeitraum).
    const {
      interval,
      limit
    } = days <= 1 ? {
      interval: '15m',
      limit: 96
    } : days <= 7 ? {
      interval: '1h',
      limit: 168
    } : days <= 30 ? {
      interval: '4h',
      limit: 180
    } : days <= 90 ? {
      interval: '12h',
      limit: 180
    } : days <= 365 ? {
      interval: '1d',
      limit: 370
    } : {
      interval: '3d',
      limit: 380
    };
    try {
      const quote = runeQuoteRef.current;
      const symbol = quote === 'BTC' ? 'RUNEBTC' : quote === 'ETH' ? 'RUNEETH' : 'RUNEUSDT';
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!res.ok) return [];
      const raw = await res.json();
      const clean = raw.map(k => ({
        date: k[0],
        value: parseFloat(k[4]),
        // Quote-Asset-Volumen (k[7]) statt Basis-Volumen (k[5]) -- entspricht bei RUNEUSDT
        // direkt dem USD-Handelsvolumen, bei RUNEBTC/RUNEETH konsistent dem Volumen in der
        // jeweils angezeigten Quote-Einheit. Wird für die optionalen Volumen-Balken im Chart
        // gebraucht (siehe allowVolume-Prop von PortfolioChart).
        volume: parseFloat(k[7])
      }))
      // Kaputte/unvollständige Einträge nie durchlassen (siehe frühere Debugging-Runde) —
      // hier ist der Effekt zwar harmloser (nur eine Linie statt Kerzen), aber ein NaN-Punkt
      // würde die Linie trotzdem an der Stelle abreißen lassen.
      .filter(d => Number.isFinite(d.date) && Number.isFinite(d.value));
      const cleanSorted = rejectValueOutliers(sortAndDedupeSeries(clean));
      // Die BTC-/ETH-Paare sind bereits in der Zieleinheit (RUNE pro BTC/ETH) -- keine
      // Fiat-Umrechnung nötig oder sinnvoll für diese beiden Modi.
      if (quote !== 'USD') return cleanSorted;
      const cur = currencyForConversionRef.current;
      const p = priceForConversionRef.current;
      if (cur !== 'usd' && p && p.usd && p.local) {
        const ratio = p.local / p.usd;
        return cleanSorted.map(d => ({
          date: d.date,
          value: d.value * ratio,
          volume: d.volume
        }));
      }
      return cleanSorted;
    } catch (e) {
      return [];
    }
  }, []);
  useEffect(() => {
    if (!showRunePriceChart) return;
    let cancelled = false;
    setRunePriceHistoryLoading(true);
    fetchRunePriceHistory(runePriceRangeDays).then(d => {
      if (cancelled) return;
      // Daten UND den gerenderten Zeitraum gemeinsam setzen -- der bisherige Chart (alter
      // Zeitraum, alter key) bleibt bis genau zu diesem Moment flüssig sichtbar; kein
      // Loading-Screen und kein Aufblitzen falscher Daten in einer neu gemounteten Instanz.
      setRunePriceHistory(d);
      setRunePriceChartRangeDays(runePriceRangeDays);
    }).finally(() => {
      if (!cancelled) setRunePriceHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [showRunePriceChart, runePriceRangeDays, runeQuote, fetchRunePriceHistory]);
  // Lässt den Chart wirklich "live" mitlaufen: derselbe Sekunden-Preis-Ticker, der auch die
  // RUNE-Kachel oben aktualisiert (siehe tick()-Effekt weiter oben, alle 1000ms), schreibt hier
  // zusätzlich den letzten Punkt der Chart-Linie fort — der Chart bewegt sich dadurch im
  // exakt gleichen Takt wie der Live-Preis, nicht nur beim Öffnen oder Zeitraum-Wechsel.
  useEffect(() => {
    if (!showRunePriceChart || !price || runeQuote !== 'USD') return;
    const livePrice = currency === 'usd' ? price.usd : price.local;
    if (livePrice == null) return;
    setRunePriceHistory(prev => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      if (last.value === livePrice) return prev;
      // Sicherheitscheck wie bei rejectValueOutliers: ein einzelner kaputter/verzögerter
      // Live-Preis-Tick (z.B. durch einen kurzzeitigen Währungsumrechnungs-Fehler) darf den
      // letzten Chart-Punkt nicht auf einen unrealistischen Ausreißer setzen -- das würde die
      // komplette Y-Achsen-Skalierung verzerren und einen Großteil der echten Kursdaten in
      // einen winzigen Streifen quetschen (der Rest des Charts wirkt dann leer/"verschluckt").
      const values = prev.map(d => d.value).filter(Number.isFinite).sort((a, b) => a - b);
      const median = values.length ? values[Math.floor(values.length / 2)] : null;
      if (median != null && median > 0 && (livePrice < median / 12 || livePrice > median * 12)) {
        return prev;
      }
      return [...prev.slice(0, -1), {
        ...last,
        value: livePrice
      }];
    });
  }, [price, currency, showRunePriceChart, runeQuote]);

  // Live-Ticker eigens für RUNE/BTC und RUNE/ETH (unabhängig vom Fiat-Preis-Ticker oben) --
  // fragt direkt das jeweilige Binance-Handelspaar ab, alle 3s (reicht für ein Kurspaar, das
  // sich selbst innerhalb von Minuten kaum merklich bewegt) statt im 1s-Takt wie beim Haupt-Preis.
  useEffect(() => {
    if (!showRunePriceChart || runeQuote === 'USD') {
      setRuneQuoteLivePrice(null);
      return;
    }
    let cancelled = false;
    const symbol = runeQuote === 'BTC' ? 'RUNEBTC' : 'RUNEETH';
    const tick = async () => {
      try {
        const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        if (!res.ok) return;
        const json = await res.json();
        const val = json && json.price != null ? parseFloat(json.price) : null;
        if (val == null || cancelled) return;
        setRuneQuoteLivePrice(val);
        setRunePriceHistory(prev => {
          if (!prev.length) return prev;
          const last = prev[prev.length - 1];
          if (last.value === val) return prev;
          const values = prev.map(d => d.value).filter(Number.isFinite).sort((a, b) => a - b);
          const median = values.length ? values[Math.floor(values.length / 2)] : null;
          if (median != null && median > 0 && (val < median / 12 || val > median * 12)) return prev;
          return [...prev.slice(0, -1), {
            ...last,
            value: val
          }];
        });
      } catch (e) {/* nächster Tick versucht es erneut */}
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showRunePriceChart, runeQuote]);

  // Vergleichs-Chart: RUNE gegen den gewählten Vergleichs-Coin, jeweils als prozentuale
  // Veränderung seit Start des Zeitraums (macht die beiden Linien unabhängig von Preisgröße
  // vergleichbar). Bewusst über den gleichen simplen Kerzen-Abruf wie der RUNE-Solo-Chart,
  // nur ohne Währungsumrechnung -- die ist für eine Prozent-Performance irrelevant.
  const [showCompareChart, setShowCompareChart] = useState(false);
  // Solange ein Chart-Modal (RUNE-Preis oder Vergleich) offen ist, darf die Seite dahinter
  // nicht mitwischen -- ein "position: fixed"-Overlay verhindert das auf iOS/Safari NICHT von
  // allein (bekannter Hintergrund-Scroll-Bug), deshalb wird der body hier zusätzlich aktiv
  // fixiert und beim Schließen exakt an der ursprünglichen Scroll-Position wiederhergestellt.
  useEffect(() => {
    if (!showRunePriceChart && !showCompareChart) return;
    const scrollY = window.scrollY;
    const {
      style
    } = document.body;
    const prev = {
      position: style.position,
      top: style.top,
      left: style.left,
      right: style.right,
      width: style.width,
      overflow: style.overflow
    };
    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.left = '0';
    style.right = '0';
    style.width = '100%';
    style.overflow = 'hidden';
    return () => {
      style.position = prev.position;
      style.top = prev.top;
      style.left = prev.left;
      style.right = prev.right;
      style.width = prev.width;
      style.overflow = prev.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [showRunePriceChart, showCompareChart]);
  const [compareRangeDays, setCompareRangeDays] = useState(() => {
    try {
      const saved = parseInt(localStorage.getItem('tp_compare_range'), 10);
      return RUNE_PRICE_CHART_RANGES.includes(saved) ? saved : 1;
    } catch (e) {
      return 1;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tp_compare_range', String(compareRangeDays));
    } catch (e) {}
  }, [compareRangeDays]);
  const [compareRangePickerOpen, setCompareRangePickerOpen] = useState(false);
  const [compareRuneHistory, setCompareRuneHistory] = useState([]);
  const [compareAltHistory, setCompareAltHistory] = useState([]);
  const [compareHistoryLoading, setCompareHistoryLoading] = useState(false);
  // Zirkulierende Menge von RUNE und TCY, für den Marketcap-Vergleichsmodus (siehe
  // altCoin.compareMode === 'marketcapPctOfRune'). Ändert sich nur sehr langsam (Burns bei
  // RUNE, TCY-Supply ist fix), deshalb reicht ein einmaliger Abruf beim Öffnen des Vergleichs-
  // Charts plus ein seltener Hintergrund-Refresh.
  const [runeSupply, setRuneSupply] = useState(null);
  const [tcySupply, setTcySupply] = useState(null);
  useEffect(() => {
    if (!showCompareChart || altCoin.compareMode !== 'marketcapPctOfRune') return;
    let cancelled = false;
    const loadSupplies = async () => {
      try {
        const [rune, tcy] = await Promise.all([fetchThorchainDenomSupply('rune'), fetchThorchainDenomSupply('tcy')]);
        if (cancelled) return;
        setRuneSupply(rune);
        setTcySupply(tcy);
      } catch (e) {
        console.warn('[RUNE Portfolio] Supply-Abruf für Marketcap-Vergleich fehlgeschlagen:', e);
      }
    };
    loadSupplies();
    const id = setInterval(loadSupplies, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [showCompareChart, altCoin.compareMode]);
  const fetchSymbolCloseHistory = useCallback(async (symbol, days) => {
    const {
      interval,
      limit
    } = days <= 1 ? {
      interval: '15m',
      limit: 96
    } : days <= 7 ? {
      interval: '1h',
      limit: 168
    } : days <= 30 ? {
      interval: '4h',
      limit: 180
    } : days <= 90 ? {
      interval: '12h',
      limit: 180
    } : days <= 365 ? {
      interval: '1d',
      limit: 370
    } : {
      interval: '3d',
      limit: 380
    };
    try {
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
      if (!res.ok) return [];
      const raw = await res.json();
      return rejectValueOutliers(sortAndDedupeSeries(raw.map(k => ({
        date: k[0],
        value: parseFloat(k[4])
      })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value))));
    } catch (e) {
      return [];
    }
  }, []);
  // Fallback für Coins ohne Binance-Notierung (z.B. TCY, RUJI) -- CoinGecko liefert keine
  // Kerzen, sondern eine reine Preis-Zeitreihe (market_chart), die hier auf dieselbe Form
  // { date, value } gebracht wird, damit CompareLineChart sie unverändert nutzen kann.
  const fetchGeckoCloseHistory = useCallback(async (geckoId, days) => {
    try {
      const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/coins/${geckoId}/market_chart?vs_currency=usd&days=${days}`);
      if (!res.ok) return [];
      const json = await res.json();
      const prices = json.prices || [];
      return rejectValueOutliers(sortAndDedupeSeries(prices.map(([ts, v]) => ({
        date: ts,
        value: v
      })).filter(d => Number.isFinite(d.date) && Number.isFinite(d.value))));
    } catch (e) {
      return [];
    }
  }, []);
  // Kleiner 24h-Preisverlauf für die Mini-Sparklines in der Preis-Kachel (siehe
  // MiniPriceSparkline / .tp-price-daily-chart) -- unabhängig vom Vergleichs-Chart-Modal,
  // läuft also immer im Hintergrund mit (dezentes Intervall von 5 Minuten reicht für einen
  // groben Tagesverlauf, kein Live-Ticker nötig).
  const [runeDailyHistory, setRuneDailyHistory] = useState([]);
  const [altDailyHistory, setAltDailyHistory] = useState([]);
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    const loadDaily = () => {
      fetchSymbolCloseHistory('RUNEUSDT', 1).then(d => {
        if (!cancelled) setRuneDailyHistory(d);
      });
      const altDailyPromise = altCoin.binanceSymbol ? fetchSymbolCloseHistory(altCoin.binanceSymbol, 1) : altCoin.krakenPair ? fetchKrakenCloseHistory(altCoin.krakenPair, 1).then(h => h.length ? h : fetchGeckoCloseHistory(altCoin.geckoId, 1)) : altCoin.poolAsset ? fetchThorchainPoolCloseHistory(altCoin.poolAsset, 1).then(h => h.length ? h : fetchGeckoCloseHistory(altCoin.geckoId, 1)) : fetchGeckoCloseHistory(altCoin.geckoId, 1);
      altDailyPromise.then(d => {
        if (!cancelled) setAltDailyHistory(d);
      });
    };
    loadDaily();
    const id = setInterval(loadDaily, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasData, altCoin.binanceSymbol, altCoin.krakenPair, altCoin.poolAsset, altCoin.geckoId, fetchSymbolCloseHistory, fetchGeckoCloseHistory]);
  useEffect(() => {
    if (!showCompareChart) return;
    let cancelled = false;
    setCompareHistoryLoading(true);
    const altHistoryPromise = altCoin.binanceSymbol ? fetchSymbolCloseHistory(altCoin.binanceSymbol, compareRangeDays) : altCoin.krakenPair ? fetchKrakenCloseHistory(altCoin.krakenPair, compareRangeDays).then(h => h.length ? h : fetchGeckoCloseHistory(altCoin.geckoId, compareRangeDays)) : altCoin.poolAsset ? fetchThorchainPoolCloseHistory(altCoin.poolAsset, compareRangeDays).then(h => h.length ? h : fetchGeckoCloseHistory(altCoin.geckoId, compareRangeDays)) : fetchGeckoCloseHistory(altCoin.geckoId, compareRangeDays);
    Promise.all([fetchSymbolCloseHistory('RUNEUSDT', compareRangeDays), altHistoryPromise]).then(([runeH, altH]) => {
      if (cancelled) return;
      setCompareRuneHistory(runeH);
      setCompareAltHistory(altH);
    }).finally(() => {
      if (!cancelled) setCompareHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [showCompareChart, compareRangeDays, altCoin.binanceSymbol, altCoin.krakenPair, altCoin.poolAsset, altCoin.geckoId, fetchSymbolCloseHistory, fetchGeckoCloseHistory]);
  const [altChange24h, setAltChange24h] = useState(null);
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    const fetchRunePct = async () => {
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/24hr?symbol=RUNEUSDT`);
      if (!res.ok) throw new Error('24H_RUNE_FAIL_' + res.status);
      const json = await res.json();
      const pct = json && json.priceChangePercent != null ? parseFloat(json.priceChangePercent) : null;
      if (pct == null) throw new Error('24H_RUNE_MISSING');
      return pct;
    };
    const fetchAltPctViaBinance = async () => {
      if (!altCoin.binanceSymbol) throw new Error('NO_BINANCE_SYMBOL');
      const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/24hr?symbol=${altCoin.binanceSymbol}`);
      if (!res.ok) throw new Error('24H_ALT_FAIL_' + res.status);
      const json = await res.json();
      const pct = json && json.priceChangePercent != null ? parseFloat(json.priceChangePercent) : null;
      if (pct == null) throw new Error('24H_ALT_MISSING');
      return pct;
    };
    const fetchAltPctViaKraken = async () => {
      if (!altCoin.krakenPair) throw new Error('NO_KRAKEN_PAIR');
      const {
        changePct
      } = await fetchKrakenPrice(altCoin.krakenPair);
      if (changePct == null) throw new Error('KRAKEN_24H_MISSING');
      return changePct;
    };
    const fetchAltPctViaPool = async () => {
      if (!altCoin.poolAsset) throw new Error('NO_POOL_ASSET');
      const {
        changePct
      } = await fetchThorchainPoolPrice(altCoin.poolAsset);
      if (changePct == null) throw new Error('POOL_24H_MISSING');
      return changePct;
    };
    const fetchAltPctViaGecko = async () => {
      const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${altCoin.geckoId}&vs_currencies=usd&include_24hr_change=true`);
      if (!res.ok) throw new Error('CG_24H_FAIL');
      const json = await res.json();
      const pct = json && json[altCoin.geckoId] ? json[altCoin.geckoId].usd_24h_change : null;
      if (pct == null) throw new Error('CG_24H_MISSING');
      return pct;
    };
    const refresh24hChange = async () => {
      // RUNE-Änderung immer separat über Binance -- läuft unabhängig davon, ob der
      // Vergleichs-Coin dort überhaupt gelistet ist, damit ein exotischer Vergleichs-Coin
      // (z.B. TCY/RUJI) nicht auch die RUNE-Anzeige mit ausfallen lässt.
      try {
        const runePct = await fetchRunePct();
        if (!cancelled) setRuneChange24h(runePct);
      } catch (e) {
        try {
          const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/simple/price?ids=thorchain&vs_currencies=usd&include_24hr_change=true');
          if (res.ok) {
            const json = await res.json();
            const pct = json && json.thorchain ? json.thorchain.usd_24h_change : null;
            if (pct != null && !cancelled) setRuneChange24h(pct);
          }
        } catch (e2) {/* Anzeige bleibt einfach weg */}
      }

      // Vergleichs-Coin: Binance -> Kraken -> RUNE/Coin-Pool (Midgard) -> CoinGecko, je
      // nachdem, was für den gewählten Coin verfügbar ist.
      try {
        const pct = await fetchAltPctViaBinance();
        if (!cancelled) setAltChange24h(pct);
        return;
      } catch (e) {/* nächste Quelle probieren */}
      try {
        const pct = await fetchAltPctViaKraken();
        if (!cancelled) setAltChange24h(pct);
        return;
      } catch (e) {/* nächste Quelle probieren */}
      try {
        const pct = await fetchAltPctViaPool();
        if (!cancelled) setAltChange24h(pct);
        return;
      } catch (e) {/* nächste Quelle probieren */}
      try {
        const pct = await fetchAltPctViaGecko();
        if (!cancelled) setAltChange24h(pct);
      } catch (e) {
        // Alle Quellen fehlgeschlagen — Anzeige bleibt einfach weg, kein harter Fehler.
      }
    };
    refresh24hChange();
    const id = setInterval(refresh24hChange, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasData, altCoin.binanceSymbol, altCoin.krakenPair, altCoin.poolAsset, altCoin.geckoId]);
  const localFxRateRef = useRef(1); // Einheiten der Zielwährung pro 1 USD (1 wenn currency === 'usd')
  const eurUsdtRateRef = useRef(null); // zuletzt bekannter EURUSDT-Kurs aus dem 1s-Ticker, für Kraken-Preisumrechnung nach EUR

  useEffect(() => {
    if (currency === 'usd') {
      localFxRateRef.current = 1;
      return;
    }
    if (currency === 'eur') return; // läuft über EURUSDT im Tick selbst
    let cancelled = false;
    const refreshFx = async () => {
      // Primär frankfurter.app (EZB-Referenzkurse, kein API-Key, schnell) -- erst wenn das
      // fehlschlägt, auf den CoinGecko-Tether-Trick ausweichen. So ist CoinGecko auch hier nur
      // noch die zweite Instanz, nicht mehr die einzige/primäre Quelle.
      try {
        const res = await fetchWithTimeout(`https://api.frankfurter.app/latest?from=USD&to=${currency.toUpperCase()}`);
        if (res.ok) {
          const json = await res.json();
          const rate = json && json.rates && json.rates[currency.toUpperCase()];
          if (rate && !cancelled) {
            localFxRateRef.current = rate;
            return;
          }
        }
      } catch (e) {/* fällt auf CoinGecko zurück */}
      try {
        // "tether" ist ein USD-Stablecoin — sein Kurs in der Zielwährung entspricht (nahezu)
        // dem USD/Zielwährung-Wechselkurs, ohne eine dedizierte FX-API zu brauchen.
        const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=${currency}`);
        if (!res.ok) return;
        const json = await res.json();
        const rate = json && json.tether && json.tether[currency];
        if (rate && !cancelled) localFxRateRef.current = rate;
      } catch (e) {/* Kurs bleibt auf dem letzten bekannten Stand */}
    };
    refreshFx();
    const id = setInterval(refreshFx, 60000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [currency]);
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    let pollTimer = null;
    // Basis-Intervall 1s (explizit gewünscht). Bei Fehlern (inkl. Rate-Limit/429) wird das
    // Intervall automatisch exponentiell verlangsamt und bei Erfolg wieder auf 1s zurückgesetzt --
    // die App rennt also nicht stur im Sekundentakt gegen eine bereits limitierte API an, sondern
    // gibt ihr kurz Luft und beschleunigt danach wieder.
    const BASE_INTERVAL_MS = 1000;
    const MAX_INTERVAL_MS = 60000;
    let currentIntervalMs = BASE_INTERVAL_MS;
    const scheduleNext = () => {
      if (cancelled) return;
      pollTimer = setTimeout(tick, currentIntervalMs);
    };
    const tick = async () => {
      try {
        // Vergleichs-Coins ohne Binance-Notierung (z.B. TCY, RUJI) werden hier bewusst NICHT
        // mit abgefragt -- Binance würde die gesamte Anfrage mit einem ungültigen Symbol
        // ablehnen. Ihr Preis läuft stattdessen über einen separaten, langsameren
        // CoinGecko-Refresh weiter unten; RUNE/EUR bleiben trotzdem sekündlich live.
        const symbols = altCoin.binanceSymbol ? `%5B%22RUNEUSDT%22%2C%22${altCoin.binanceSymbol}%22%2C%22EURUSDT%22%5D` : `%5B%22RUNEUSDT%22%2C%22EURUSDT%22%5D`;
        const res = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbols=${symbols}`);
        if (res.status === 429 || res.status === 418) throw new Error('POLL_RATE_LIMITED');
        if (!res.ok) throw new Error('POLL_FAIL_' + res.status);
        const json = await res.json();
        const getP = sym => {
          const entry = Array.isArray(json) ? json.find(x => x.symbol === sym) : null;
          return entry ? parseFloat(entry.price) : null;
        };
        const rune = getP('RUNEUSDT');
        const alt = altCoin.binanceSymbol ? getP(altCoin.binanceSymbol) : null;
        const eurUsdt = getP('EURUSDT');
        if (rune == null || eurUsdt == null || altCoin.binanceSymbol && alt == null) throw new Error('POLL_MISSING_DATA');
        if (cancelled) return;
        eurUsdtRateRef.current = eurUsdt;
        const toLocal = usdVal => {
          if (currency === 'usd') return usdVal;
          if (currency === 'eur') return usdVal / eurUsdt;
          return usdVal * localFxRateRef.current;
        };
        setPrice({
          usd: rune,
          local: toLocal(rune)
        });
        if (altCoin.binanceSymbol) setAltPrice({
          usd: alt,
          local: toLocal(alt)
        });
        setLastUpdated(new Date());
        setLiveConnected(true);
        currentIntervalMs = BASE_INTERVAL_MS; // Erfolg -> zurück auf normales Tempo
      } catch (e) {
        console.warn('[RUNE Portfolio] Live-Preis-Polling fehlgeschlagen:', e);
        if (!cancelled) setLiveConnected(false);
        // Bei anhaltenden Fehlern (v.a. Rate-Limit) das Intervall verdoppeln statt weiter im
        // Basistakt gegen die API zu rennen -- die App bleibt dabei voll benutzbar, es zeigt
        // sich nur, dass der Live-Preis gerade nicht aktuell ist (siehe liveConnected-Anzeige).
        currentIntervalMs = Math.min(currentIntervalMs * 2, MAX_INTERVAL_MS);
      } finally {
        scheduleNext();
      }
    };
    tick(); // sofort einmal ausführen, danach im (adaptiven) Intervall

    return () => {
      cancelled = true;
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [hasData, altCoin.binanceSymbol, currency]);

  // Für Vergleichs-Coins ohne Binance-Notierung (z.B. TCY, RUJI) übernimmt der 1-Sekunden-
  // Ticker oben bewusst keinen Live-Preis mehr (siehe dort) -- stattdessen wird altPrice hier
  // separat und deutlich seltener (alle 20s) aktualisiert. Ist der Coin auf Kraken gelistet
  // (krakenPair, z.B. RUJI), läuft das primär über Kraken; ist er ein natives THORChain-Asset
  // (poolAsset, z.B. TCY), läuft es über dessen eigenen RUNE-Pool via Midgard. CoinGecko dient
  // nur als allerletzter Notfall-Fallback, falls beides mal nicht erreichbar ist.
  useEffect(() => {
    if (!hasData || altCoin.binanceSymbol) return;
    let cancelled = false;
    const toLocalFromUsd = usdVal => {
      if (currency === 'usd') return usdVal;
      if (currency === 'eur') return eurUsdtRateRef.current ? usdVal / eurUsdtRateRef.current : usdVal;
      return usdVal * localFxRateRef.current;
    };
    const refreshAltPrice = async () => {
      if (altCoin.krakenPair) {
        try {
          const {
            usd
          } = await fetchKrakenPrice(altCoin.krakenPair);
          if (cancelled) return;
          setAltPrice({
            usd,
            local: toLocalFromUsd(usd)
          });
          return;
        } catch (e) {
          console.warn('[RUNE Portfolio] Kraken-Live-Preis für', altCoin.code, 'fehlgeschlagen, weiche auf CoinGecko aus:', e);
        }
      }
      if (altCoin.poolAsset) {
        try {
          const {
            usd
          } = await fetchThorchainPoolPrice(altCoin.poolAsset);
          if (cancelled) return;
          setAltPrice({
            usd,
            local: toLocalFromUsd(usd)
          });
          return;
        } catch (e) {
          console.warn('[RUNE Portfolio] Pool-Live-Preis für', altCoin.code, 'fehlgeschlagen, weiche auf CoinGecko aus:', e);
        }
      }
      try {
        const res = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${altCoin.geckoId}&vs_currencies=usd,${currency}`);
        if (!res.ok) throw new Error('GECKO_ALT_FAIL_' + res.status);
        const json = await res.json();
        const entry = json && json[altCoin.geckoId];
        if (!entry || entry.usd == null) throw new Error('GECKO_ALT_MISSING');
        if (cancelled) return;
        const local = currency === 'usd' ? entry.usd : entry[currency] != null ? entry[currency] : entry.usd;
        setAltPrice({
          usd: entry.usd,
          local
        });
      } catch (e) {
        console.warn('[RUNE Portfolio] CoinGecko-Live-Preis für', altCoin.code, 'fehlgeschlagen:', e);
      }
    };
    refreshAltPrice();
    const id = setInterval(refreshAltPrice, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [hasData, altCoin.binanceSymbol, altCoin.krakenPair, altCoin.poolAsset, altCoin.geckoId, altCoin.code, currency]);

  // 24h-Volumen (+ dessen 30-Tage-Historie fürs Sparkline) alle 30s automatisch neu abfragen,
  // damit es nicht nur beim initialen Laden bzw. manuellen Refresh aktuell ist.
  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const [vol, hist] = await Promise.all([fetchVolume24h(), fetchVolumeHistory()]);
        if (cancelled) return;
        if (vol != null) setVolume24h(vol);
        if (hist != null) setVolumeHistory(patchLastVolumeWithLive(hist, vol));
      } catch (e) {
        console.warn('[RUNE Portfolio] Auto-Refresh Volumen fehlgeschlagen:', e);
      }
    };
    const volTimer = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      clearInterval(volTimer);
    };
  }, [hasData]);

  // Balance & Bonded laufen jetzt über unser eigenes rune-rewards-backend statt direkt gegen
  // Liquify/THORNode aus dem Browser - das behebt das CORS-Problem endgültig: gateway.liquify.com
  // ist zwar browserfreundlich (hat CORS-Header gesetzt), aber JEDER Fallback-Endpunkt (z.B. ein
  // roher THORNode wie thornode.ninerealms.com) hat KEINE CORS-Freigabe für Browser-Anfragen und
  // schlägt deshalb aus dem Browser heraus praktisch IMMER fehl, nicht nur gelegentlich - ein
  // Browser-seitiger Fallback auf einen zweiten Anbieter kann das strukturell nicht lösen.
  // Server-zu-Server-Anfragen (in unserem Worker) haben dieses Problem nicht.
  const fetchBalanceWithFallback = async addr => {
    const attempt = async () => {
      const res = await fetchWithTimeout(`${REWARDS_BACKEND_BASE}/balance?address=${encodeURIComponent(addr)}`, {}, 15000);
      if (!res.ok) throw new Error('HTTP_' + res.status);
      const data = await res.json();
      if (data.balance == null) throw new Error(data.balanceError || 'BALANCE_FETCH_FAILED');
      return data;
    };
    let data;
    try {
      data = await attempt();
    } catch (e) {
      // Ein einzelner kurzer Aussetzer (z.B. Liquify kurzzeitig instabil, oder das Gerät hat die
      // App gerade erst aus dem Hintergrund/Standby geholt und die Netzwerkverbindung ist noch
      // nicht ganz da) soll nicht sofort als Fehler beim Nutzer aufschlagen -> zwei stille
      // Versuche (1.5s, dann nochmal 2.5s) bevor wir wirklich aufgeben. Das gibt gerade dem
      // "App schließen und sofort wieder öffnen"-Fall genug Zeit, sich von selbst zu erholen.
      try {
        await sleep(1500);
        data = await attempt();
      } catch (e2) {
        await sleep(2500);
        data = await attempt();
      }
    }
    // Gleiche Form wie die alte Cosmos-Bank-Antwort beibehalten, damit der Rest des Codes
    // (der `balances`/`denom`/`amount` erwartet) unverändert weiterfunktioniert.
    return {
      balances: [{
        denom: 'rune',
        amount: String(Math.round(data.balance * 1e8))
      }]
    };
  };

  // Summiert bonded RUNE über alle Nodes, bei denen die Adresse als Bond Provider
  // (oder Node Operator) gelistet ist. Liefert zusätzlich den gesamten aktiven Netzwerk-Bond
  // mit (wird für die Churn-Reward-Schätzung gebraucht). Gibt { bonded: null, ... } zurück,
  // wenn die Abfrage fehlschlägt (dann wird bonded RUNE einfach als 0 behandelt).
  // Ebenfalls über unser eigenes Backend statt direkt gegen Liquify/THORNode - siehe
  // ausführliche Begründung beim CORS-Problem oben bei fetchBalanceWithFallback.
  // Kurzlebiger Cache (3s) für fetchBondedRune: mehrere Stellen in der App (fetchPortfolio,
  // fetchNodeRewardsFor, der Accrued-Hintergrund-Refresh) fragen für dieselbe Adresse denselben
  // /balance-Endpunkt ab, oft innerhalb weniger Sekunden. Statt jedes Mal eine eigene
  // Netzwerk-Anfrage zu starten, wird ein bereits laufender/kürzlich abgeschlossener Abruf für
  // dieselbe Adresse einfach wiederverwendet -- weniger Anfragen, schnellere Antwort für die
  // "zweite" Stelle, OHNE die zurückgegebenen Daten oder irgendeine Logik zu verändern.
  const bondedRuneCacheRef = useRef({}); // addr -> { promise, atMs }
  const BONDED_RUNE_CACHE_MS = 3000;
  const fetchBondedRune = async addr => {
    const cached = bondedRuneCacheRef.current[addr];
    if (cached && Date.now() - cached.atMs < BONDED_RUNE_CACHE_MS) {
      return cached.promise;
    }
    const attempt = async () => {
      const res = await fetchWithTimeout(`${REWARDS_BACKEND_BASE}/balance?address=${encodeURIComponent(addr)}`, {}, 15000);
      if (!res.ok) throw new Error('HTTP_' + res.status);
      return res.json();
    };
    const promise = (async () => {
      let data;
      try {
        data = await attempt();
      } catch (e) {
        // WICHTIG: derselbe kurze Still-Retry wie bei fetchBalanceWithFallback. Ohne ihn führte
        // ein einzelner Aussetzer beim allerersten Laden (z.B. kalter Worker-Start) dazu, dass
        // Bonded fälschlich auf 0 zurückfiel und der Portfolio-Wert kurzzeitig viel zu niedrig
        // angezeigt wurde ("nur Balance, ohne Bonded") - das ist genau der gemeldete Bug.
        try {
          await sleep(1500);
          data = await attempt();
        } catch (e2) {
          return {
            bonded: null,
            totalActiveBondBase: null,
            accruedAward: null,
            matchedNodeAddresses: [],
            nodeBreakdown: []
          };
        }
      }
      return {
        bonded: data.bonded,
        totalActiveBondBase: data.totalActiveBondBase,
        accruedAward: data.accruedAward,
        matchedNodeAddresses: data.matchedNodeAddresses || [],
        nodeBreakdown: data.nodeBreakdown || []
      };
    })();
    bondedRuneCacheRef.current[addr] = {
      promise,
      atMs: Date.now()
    };
    return promise;
  };

  // Countdown bis zum nächsten Churn (= wann der aufgelaufene Reward tatsächlich ausgezahlt
  // wird). nextChurnHeight kommt von Midgard, die aktuelle Blockhöhe von THORNode; die Differenz
  // in Blöcken × ~6 Sekunden/Block ergibt die verbleibende Zeit (THORChain-Standard-Blockzeit).
  // Zusätzlich wird das HALTCHURNING-Mimir-Flag geprüft: ist Churning pausiert, ist eine reine
  // Blockhöhen-Rechnung irreführend (Verzögerungen kommen häufig vor) — dann zeigen wir
  // stattdessen klar "pausiert" an, statt eine falsche/zu genaue Restzeit vorzugaukeln.
  //
  // Zusätzlich werden hier progressedBlocks/totalBlocks/lastChurnHeight ermittelt -- das sind
  // genau die Eingaben, die Boones estimateCurrentChurnYields() für die Live-Churn-APY braucht
  // (siehe oben). lastChurnHeight kommt aus der ohnehin gecachten Churn-Liste (fetchChurnsList),
  // totalBlocks bevorzugt aus nextChurnHeight - lastChurnHeight (echter, nicht nomineller Wert);
  // falls die Churn-Liste mal leer ist, dient der Mimir-Wert CHURNINTERVAL als Fallback.
  const [churnCountdown, setChurnCountdown] = useState(null); // { nextChurnEstimateMs, halted, progressedBlocks, totalBlocks, secondsPerBlock, lastChurnTimestampSec }
  const fetchChurnCountdown = useCallback(async () => {
    try {
      const [networkRes, blockRes, mimirRes, churns] = await Promise.all([thorchainFetch('https://gateway.liquify.com/chain/thorchain_midgard/v2/network', {
        headers: {
          'x-client-id': 'rune-portfolio-app'
        }
      }), fetchThorchainApiWithFallback('/thorchain/lastblock'), fetchThorchainApiWithFallback('/thorchain/mimir'),
      // Parallel statt erst NACH den drei Requests oben -- das hat bisher unnötig Zeit gekostet,
      // bis die Live-APY (die churnCountdown braucht) zum ersten Mal einen Wert hatte.
      fetchChurnsList().catch(() => [])]);
      if (!networkRes.ok || !blockRes.ok) return;
      const network = await networkRes.json();
      const blocks = await blockRes.json();
      let halted = false;
      let churnIntervalBlocksMimir = 0;
      if (mimirRes.ok) {
        try {
          const mimir = await mimirRes.json();
          // Key-Suche case-insensitiv, THORNode liefert i.d.R. Großbuchstaben-Keys.
          const haltKey = Object.keys(mimir || {}).find(k => k.toUpperCase() === 'HALTCHURNING');
          halted = haltKey != null && Number(mimir[haltKey]) === 1;
          const intervalKey = Object.keys(mimir || {}).find(k => k.toUpperCase() === 'CHURNINTERVAL');
          churnIntervalBlocksMimir = intervalKey != null ? Number(mimir[intervalKey]) || 0 : 0;
        } catch (e) {/* Mimir optional, bei Fehler einfach nicht als pausiert werten */}
      }
      const nextChurnHeight = parseInt(network.nextChurnHeight, 10);
      const currentHeight = parseInt(blocks && blocks[0] && blocks[0].thorchain || '0', 10);

      // lastChurnHeight aus der gecachten Churn-Liste (letzter, also jüngster Eintrag) -- das ist
      // der ECHTE Startpunkt des aktuell laufenden Churns, nicht nur eine Annäherung. Schlägt das
      // fehl/ist leer, dient CHURNINTERVAL (Mimir) als Fallback für totalBlocks.
      let lastChurnHeight = 0;
      let lastChurnTimestampSec = 0;
      if (churns && churns.length) {
        const last = churns[churns.length - 1];
        lastChurnHeight = last.height;
        lastChurnTimestampSec = Math.floor(last.dateMs / 1000);
      }
      const totalBlocks = nextChurnHeight && lastChurnHeight && nextChurnHeight > lastChurnHeight ? nextChurnHeight - lastChurnHeight : churnIntervalBlocksMimir;
      const progressedBlocks = currentHeight && lastChurnHeight ? Math.max(0, currentHeight - lastChurnHeight) : 0;
      if (!nextChurnHeight || !currentHeight) {
        setChurnCountdown({
          nextChurnEstimateMs: null,
          halted,
          totalBlocks,
          progressedBlocks,
          secondsPerBlock: 6,
          lastChurnTimestampSec
        });
        return;
      }
      const blocksRemaining = Math.max(0, nextChurnHeight - currentHeight);
      const secondsRemaining = blocksRemaining * 6;
      setChurnCountdown({
        nextChurnEstimateMs: Date.now() + secondsRemaining * 1000,
        halted,
        totalBlocks,
        progressedBlocks,
        secondsPerBlock: 6,
        lastChurnTimestampSec
      });
    } catch (e) {
      // Countdown ist ein Extra — bei Fehler einfach nichts anzeigen, Rest der App bleibt unberührt.
    }
  }, []);
  useEffect(() => {
    fetchChurnCountdown();
    const id = setInterval(fetchChurnCountdown, 5 * 60 * 1000); // alle 5 Minuten reicht, ändert sich selten
    return () => clearInterval(id);
  }, [fetchChurnCountdown]);

  // Bond-Rewards, exakt: THORChain-Bond-Rewards werden zwar automatisch in den Bond
  // eingerechnet (keine einzelnen "Reward-Events"), aber wir können sie trotzdem rückwirkend
  // berechnen: Gesamt-Rewards = aktueller Bond − (Summe aller BOND-Einzahlungen − Summe aller
  // UNBOND-Auszahlungen). Diese Ein-/Auszahlungen sind echte, historisch abrufbare Transaktionen
  // über die Midgard-API. Schlägt das fehl (z.B. Netzwerkproblem), fällt die App automatisch auf
  // ein lokales "seit App-Nutzung"-Tracking zurück.
  // Nine Realms hat den Betrieb komplett eingestellt — midgard.ninerealms.com existiert daher
  // nicht mehr. Liquify ist der von der THORChain-Doku empfohlene Haupt-Gateway;
  // midgard.thorchain.network ist die offiziell dokumentierte öffentliche Alternative.
  const MIDGARD_BASES = ['https://gateway.liquify.com/chain/thorchain_midgard/v2', 'https://midgard.thorchain.network/v2'];

  // 24h-Handelsvolumen des gesamten THORChain-Netzwerks — dieselbe Datenquelle (Midgard),
  // die auch thorchain.net für diese Kennzahl verwendet. Wir summieren 24 Stunden-Intervalle
  // statt ein einzelnes Tages-Intervall zu nehmen — dadurch entsteht kein Problem, falls der
  // aktuelle UTC-Tag gerade erst begonnen hat (was sonst fälschlich nahe 0 anzeigen würde).
  const fetchVolume24h = async () => {
    for (const base of MIDGARD_BASES) {
      try {
        const res = await thorchainFetch(`${base}/history/swaps?interval=hour&count=24`, {
          headers: {
            'x-client-id': 'rune-portfolio-app'
          }
        });
        if (!res.ok) {
          console.warn('[RUNE Portfolio] Volumen-Anfrage HTTP-Fehler', res.status, base);
          continue;
        }
        const json = await res.json();
        const intervals = json.intervals || [];
        if (!intervals.length) {
          console.warn('[RUNE Portfolio] Volumen: keine Intervalle in Antwort von', base, json);
          continue;
        }
        console.info('[RUNE Portfolio] Volumen-Rohdaten (erstes Intervall):', intervals[0]);
        let totalBase = 0;
        let foundField = false;
        for (const iv of intervals) {
          const raw = iv.totalVolume ?? iv.volume ?? null;
          if (raw == null) continue;
          const n = parseInt(raw, 10);
          if (isFinite(n)) {
            totalBase += n;
            foundField = true;
          }
        }
        if (!foundField) {
          console.warn('[RUNE Portfolio] Volumen: kein bekanntes Volumen-Feld gefunden, Beispiel-Intervall:', intervals[0]);
          continue;
        }
        return totalBase / 1e8; // RUNE
      } catch (e) {
        console.warn('[RUNE Portfolio] Netzwerkfehler bei Volumen-Anfrage:', base, e);
      }
    }
    return null;
  };

  // Tages-Volumen der letzten 30 Tage (für den kleinen Sparkline-Graphen unter dem
  // 24h-Volumen-Wert). Gleiche Datenquelle wie fetchVolume24h, nur mit Tages-Intervallen.
  const fetchVolumeHistory = async () => {
    for (const base of MIDGARD_BASES) {
      try {
        const res = await thorchainFetch(`${base}/history/swaps?interval=day&count=30`, {
          headers: {
            'x-client-id': 'rune-portfolio-app'
          }
        });
        if (!res.ok) continue;
        const json = await res.json();
        const intervals = json.intervals || [];
        if (!intervals.length) continue;
        const points = intervals.map(iv => {
          const raw = iv.totalVolume ?? iv.volume ?? null;
          const n = raw != null ? parseInt(raw, 10) : NaN;
          return {
            t: parseInt(iv.startTime, 10) * 1000,
            volumeRune: isFinite(n) ? n / 1e8 : 0
          };
        });
        return points;
      } catch (e) {
        console.warn('[RUNE Portfolio] Netzwerkfehler bei Volumen-Historie-Anfrage:', base, e);
      }
    }
    return null;
  };

  // WICHTIG: Der letzte Balken der 30-Tage-Historie oben ist NUR das laufende UTC-Kalendertag
  // (00:00 UTC bis jetzt) — je nach Tageszeit oft nur ein Bruchteil eines vollen Tages. Die große
  // "24H VOLUME"-Zahl daneben ist dagegen ein echtes rollierendes 24h-Fenster (Summe der letzten
  // 24 Stunden-Intervalle). Beide zeigen deshalb unterschiedliche Zeitfenster — genau das sorgte
  // für den Eindruck, der Graph würde sich trotz eines veränderten 24h-Werts kaum bewegen. Fix:
  // den letzten Punkt der Historie durch den live rollierenden 24h-Wert ersetzen, damit Balken
  // und Kopfzahl immer dasselbe Zeitfenster zeigen und sich synchron bewegen.
  const patchLastVolumeWithLive = (hist, liveVol24h) => {
    if (!hist || !hist.length || liveVol24h == null) return hist;
    const patched = hist.slice();
    patched[patched.length - 1] = {
      ...patched[patched.length - 1],
      volumeRune: liveVol24h
    };
    return patched;
  };

  // Ruft Midgard-Actions ab und summiert Bond-/Unbond-Beträge. Probiert mehrere Basis-URLs
  // (Liquify zuerst) und Filter-Varianten durch und filtert zusätzlich clientseitig nach dem
  // tatsächlichen "type"-Feld jeder zurückgegebenen Aktion — das ist die zuverlässigste Methode.
  const fetchActionsForType = async (addr, txType) => {
    const attempts = [];
    for (const base of MIDGARD_BASES) {
      attempts.push(`${base}/actions?address=${addr}&txType=${txType}&limit=50`);
      attempts.push(`${base}/actions?address=${addr}&type=${txType}&limit=50`);
    }
    let lastErrorDetail = null; // technisches Detail des letzten Fehlschlags, für UI/Diagnose
    for (const baseUrl of attempts) {
      let offset = 0;
      let pages = 0;
      let totalBase = 0;
      let earliestDateMs = null;
      let matchedAny = false;
      let hadError = false;
      const items = [];
      while (pages < 12) {
        const url = `${baseUrl}&offset=${offset}`;
        let res;
        try {
          res = await thorchainFetch(url, {
            headers: {
              'x-client-id': 'rune-portfolio-app'
            }
          });
        } catch (netErr) {
          console.warn('[RUNE Portfolio] Netzwerkfehler bei Midgard-Anfrage (evtl. CORS):', url, netErr);
          lastErrorDetail = `Netzwerkfehler (${netErr && netErr.name + ': ' + netErr.message || netErr}) bei ${new URL(url).host}`;
          hadError = true;
          break;
        }
        if (!res.ok) {
          const bodyText = await res.text().catch(() => '');
          console.warn('[RUNE Portfolio] Midgard antwortete mit Fehler', res.status, url, bodyText.slice(0, 300));
          lastErrorDetail = `HTTP ${res.status} von ${new URL(url).host}${bodyText ? ' — ' + bodyText.slice(0, 120) : ''}`;
          hadError = true;
          break;
        }
        const json = await res.json();
        const actions = json.actions || [];
        if (actions.length === 0) break;
        for (const a of actions) {
          if (a.type !== txType) continue; // clientseitiger Filter, unabhängig vom URL-Parameter
          matchedAny = true;
          let amountBase = 0;
          const coinsGroups = txType === 'bond' ? a.in || [] : a.out && a.out.length ? a.out : a.in || [];
          for (const grp of coinsGroups) {
            for (const c of grp.coins || []) {
              if (c.asset === 'THOR.RUNE' || c.asset === 'RUNE') {
                amountBase += parseInt(c.amount, 10) || 0;
              }
            }
          }
          totalBase += amountBase;
          const dateMs = a.date ? Math.floor(parseInt(a.date, 10) / 1e6) : null;
          if (dateMs && (earliestDateMs === null || dateMs < earliestDateMs)) earliestDateMs = dateMs;
          // Die Node-Adresse steckt direkt in den Metadaten jeder Bond/Unbond-Transaktion
          // (metadata.bond.nodeAddress, gilt für beide Richtungen) — das ist entscheidend, um
          // auch Nodes zu finden, von denen die Adresse inzwischen komplett abgebonded hat und
          // die deshalb in der AKTUELLEN Node-Liste nicht mehr auftauchen.
          const nodeAddress = a.metadata && a.metadata.bond && a.metadata.bond.nodeAddress || null;
          items.push({
            dateMs,
            amount: amountBase / 1e8,
            type: txType,
            txId: a.in && a.in[0] && a.in[0].txID || null,
            height: parseInt(a.height, 10) || null,
            nodeAddress
          });
        }
        if (actions.length < 50) break;
        offset += 50;
        pages++;
      }
      if (hadError) continue; // nächste URL-Variante probieren
      if (matchedAny) {
        console.info(`[RUNE Portfolio] Midgard-Treffer für Typ "${txType}" über`, baseUrl.split('?')[1].split('&')[1]);
        return {
          totalBase,
          earliestDateMs,
          found: true,
          items
        };
      }
      // 0 Treffer, aber kein technischer Fehler -> könnte einfach bedeuten "nie unbonded" o.ä.
    }
    return {
      totalBase: 0,
      earliestDateMs: null,
      found: false,
      items: [],
      errorDetail: lastErrorDetail
    };
  };
  const fetchBondLedger = async addr => {
    try {
      const bondRes = await fetchActionsForType(addr, 'bond');
      if (!bondRes.found) {
        console.warn('[RUNE Portfolio] Keine BOND-Aktionen über Midgard gefunden für', addr, bondRes.errorDetail || '');
        throw new Error(bondRes.errorDetail || 'NO_BOND_ACTIONS');
      }
      const unbondRes = await fetchActionsForType(addr, 'unbond');
      const allItems = [...bondRes.items, ...unbondRes.items].sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
      return {
        success: true,
        principal: (bondRes.totalBase - unbondRes.totalBase) / 1e8,
        earliestDateMs: bondRes.earliestDateMs,
        transactions: allItems
      };
    } catch (e) {
      console.warn('[RUNE Portfolio] Bond-Ledger via Midgard fehlgeschlagen, falle zurück auf lokales Tracking:', e);
      return {
        success: false,
        errorDetail: e && e.message || String(e)
      };
    }
  };

  // Liste aller Churns (Höhe + Zeitpunkt) von Midgard — global, unabhängig von der Adresse.
  // Einzelne Churn-Einträge ändern sich NIE nachträglich (historische Blockhöhen sind fix) —
  // der Cache wird deshalb NIE verworfen/für ungültig erklärt. Es kommen aber weiterhin neue
  // Churns hinzu, solange das Netzwerk läuft — daher wird bei jedem Aufruf einmal (günstig,
  // dank globaler thorchainFetch-Warteschlange nur eine einzelne Anfrage) nachgesehen, ob es
  // neuere Einträge als den zuletzt bekannten gibt, und diese werden dem Cache nur HINZUGEFÜGT
  // (kein Neuladen/Überschreiben der bereits bekannten, garantiert unveränderlichen Einträge).
  // Schlägt der Netzwerk-Request fehl, wird einfach der vorhandene Cache weiterverwendet.
  const CHURNS_CACHE_KEY = 'tp_churns_cache_v1';
  const fetchChurnsList = async () => {
    let cached = null;
    try {
      const raw = localStorage.getItem(CHURNS_CACHE_KEY);
      if (raw) cached = JSON.parse(raw);
    } catch (e) {
      cached = null;
    }
    const cachedChurns = cached && Array.isArray(cached.churns) ? cached.churns : [];
    const knownHeight = cachedChurns.length ? cachedChurns[cachedChurns.length - 1].height : null;
    for (const base of MIDGARD_BASES) {
      try {
        const res = await thorchainFetch(`${base}/churns`, {
          headers: {
            'x-client-id': 'rune-portfolio-app'
          }
        });
        if (!res.ok) continue;
        const raw = await res.json();
        if (!Array.isArray(raw) || raw.length === 0) continue;
        const fresh = raw.map(c => ({
          height: parseInt(c.height, 10),
          dateMs: Math.floor(parseInt(c.date, 10) / 1e6)
        })).filter(c => c.height && c.dateMs).sort((a, b) => a.height - b.height); // aufsteigend, älteste zuerst

        // Nur wirklich neue Höhen anhängen — bereits bekannte, unveränderliche Einträge
        // bleiben unangetastet (kein unnötiges Überschreiben identischer Daten).
        const merged = knownHeight != null ? [...cachedChurns, ...fresh.filter(c => c.height > knownHeight)] : fresh;
        if (merged.length !== cachedChurns.length) {
          try {
            localStorage.setItem(CHURNS_CACHE_KEY, JSON.stringify({
              churns: merged
            }));
          } catch (e) {/* Speicher evtl. voll */}
        }
        return merged;
      } catch (e) {
        // nächste Basis probieren
      }
    }
    // Alle Basen fehlgeschlagen: lieber der (evtl. nicht ganz taggenaue) Cache als gar nichts.
    if (cachedChurns.length) {
      console.warn('[RUNE Portfolio] Churn-Liste konnte nicht aktualisiert werden, nutze lokalen Cache (letzte bekannte Höhe:', knownHeight, ')');
    }
    return cachedChurns;
  };

  // Die historischen Höhenabfragen (ein Request pro Churn × Node-Adresse) laufen jetzt NICHT
  // mehr live im Browser, sondern zentral im rune-rewards-backend-Worker (siehe
  // fetchRewardHistoryFromBackend weiter unten) — das behebt sowohl das Rate-Limiting/CORS-
  // Problem als auch die Abhängigkeit vom mittlerweile toten thornode-archive.ninerealms.com.

  // Berechnet aus einem (historischen oder aktuellen) einzelnen Node-Objekt den Reward-Anteil
  // einer Bond-Adresse — dieselbe Formel wie in fetchBondedRune, nur für einen einzelnen Node.
  const computeAddressAwardFromNode = (node, addr) => {
    if (!node) return 0;
    const providers = node.bond_providers && node.bond_providers.providers || [];
    let nodeTotalBondBase = 0;
    let myBondInNodeBase = 0;
    for (const p of providers) {
      const pBond = parseInt(p.bond, 10) || 0;
      nodeTotalBondBase += pBond;
      if (p.bond_address === addr) myBondInNodeBase = pBond;
    }
    if (myBondInNodeBase <= 0 || nodeTotalBondBase <= 0) return 0;
    const feeBps = parseInt(node.bond_providers && node.bond_providers.node_operator_fee || '0', 10) || 0;
    const fee = feeBps / 10000;
    const currentAwardBase = parseInt(node.current_award, 10) || 0;
    return myBondInNodeBase / nodeTotalBondBase * currentAwardBase * (1 - fee) / 1e8;
  };

  // Baut die Reward-Historie für EINE Adresse NICHT MEHR live im Browser auf, sondern über das
  // rune-rewards-backend (Cloudflare Worker + D1) — siehe /boone-rewards-worker im Projekt-Repo.
  // Der Worker fragt THORNode serverseitig ab (kein CORS/Rate-Limit-Problem mehr), speichert das
  // Ergebnis dauerhaft in D1 (für ALLE Besucher gemeinsam, nicht nur im lokalen localStorage)
  // und baut die Historie im Hintergrund per Cron weiter, auch wenn hier niemand die Seite offen
  // hat. Trag hier die URL deines deployten Workers ein (siehe README im Worker-Projekt,
  // Schritt "npm run deploy").
  const REWARDS_BACKEND_BASE = 'https://rune-rewards-backend.maxkalinowski.workers.dev';
  const REWARDS_BACKEND_POLL_MS = 4000; // wie oft nachgefragt wird, solange der Server noch baut ("building")

  // Fragt den Worker einmal ab: { status: 'pending'|'building'|'done', total, entries, principal, currentBond, earliestDateMs, ledgerError }
  const fetchRewardHistoryFromBackend = async addr => {
    const res = await fetchWithTimeout(`${REWARDS_BACKEND_BASE}/bond-history?address=${encodeURIComponent(addr)}`);
    if (!res.ok) throw new Error('BACKEND_HTTP_' + res.status);
    return res.json();
  };

  // Ersetzt das alte lokale Batch-für-Batch-Abfragen (buildAutoRewardHistory): pollt den Worker,
  // bis er mit dem Aufbau der Historie fertig ist ("done"), und ruft nach jeder Antwort
  // onBatch(...) mit dem bisherigen Zwischenstand auf — genau wie vorher, nur dass die eigentliche
  // Arbeit jetzt serverseitig läuft. isCancelled() bricht das Polling ab, wenn z.B. die Adresse
  // gewechselt wurde, bevor der vorherige Poll-Zyklus fertig ist.
  const REWARDS_BACKEND_MAX_POLLS = 60; // Sicherheitsgrenze (~4 Minuten bei 4s-Intervall), falls der Server nie fertig wird
  const buildAutoRewardHistory = async (addr, isCancelled, onBatch) => {
    for (let poll = 0; poll < REWARDS_BACKEND_MAX_POLLS; poll++) {
      if (isCancelled && isCancelled()) return {
        entries: [],
        attempted: 0,
        failed: 0,
        status: 'cancelled'
      };
      let data;
      try {
        data = await fetchRewardHistoryFromBackend(addr);
      } catch (e) {
        return {
          entries: [],
          attempted: 1,
          failed: 1,
          status: 'error',
          errorDetail: e.message
        };
      }
      const entries = (data.entries || []).map(e => ({
        dateMs: e.dateMs,
        amount: e.amount,
        height: e.height,
        isAuto: true
      }));
      if (onBatch) onBatch(entries, data);
      if (data.status === 'done') {
        return {
          entries,
          attempted: entries.length,
          failed: 0,
          status: 'done',
          principal: data.principal,
          currentBond: data.currentBond,
          earliestDateMs: data.earliestDateMs,
          ledgerError: data.ledgerError
        };
      }
      await sleep(REWARDS_BACKEND_POLL_MS);
    }
    return {
      entries: [],
      attempted: 0,
      failed: 0,
      status: 'timeout'
    };
  };

  // Reward-Tracking für die AKTUELL geladene Wallet-Adresse — nicht mehr auf bestimmte
  // Adressen beschränkt. Jeder Besucher sieht seine eigene Bond-Rewards-Historie, sobald er
  // seine eigene Adresse eingibt und diese Bond > 0 hat.
  const [nodeRewardsData, setNodeRewardsData] = useState({}); // addr -> { loading, error, current, principal, transactions, earliestDateMs, accruedAward }
  const [autoRewardHistory, setAutoRewardHistory] = useState({}); // addr -> [{ dateMs, amount, height, isAuto }]
  const [autoHistoryStatus, setAutoHistoryStatus] = useState('idle'); // 'idle' | 'loading' | 'done' | 'error'
  const [autoHistoryProgress, setAutoHistoryProgress] = useState(null); // { done, total }
  // alle Adressen mit Bond > 0, für die Rewards nachgeladen werden. Wird aus dem letzten
  // bekannten Stand (localStorage) vorbefüllt, statt leer zu starten -- so kann die
  // Reward-Cache-Hydrierung (siehe Effekt weiter unten) SOFORT beim Start loslegen, parallel zum
  // Haupt-Balance/Bonded-Abruf, statt erst auf dessen vollständigen Abschluss zu warten. Das ist
  // der eigentliche Grund, warum der accrued-Anteil im Portfolio-Wert bisher immer erst ein paar
  // Sekunden verzögert "nachgepoppt" ist: trackedAddresses wurde bislang erst GANZ am Ende des
  // Haupt-Fetches gesetzt. fetchPortfolio() überschreibt diesen Wert weiterhin mit der
  // autoritativen Liste, sobald es fertig ist -- das hier ist nur eine optimistische Vorschau für
  // den allerersten Render.
  const TRACKED_ADDRESSES_CACHE_KEY = 'tp_tracked_addresses';
  const [trackedAddresses, setTrackedAddresses] = useState(() => {
    try {
      const raw = localStorage.getItem(TRACKED_ADDRESSES_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(TRACKED_ADDRESSES_CACHE_KEY, JSON.stringify(trackedAddresses));
    } catch (e) {}
  }, [trackedAddresses]);
  const [rewardsListExpanded, setRewardsListExpanded] = useState(false); // Rewards-Liste per Klick auf-/zuklappen
  const [exportMenuOpen, setExportMenuOpen] = useState(false); // Dropdown für CSV-Export-Auswahl (Historie vs. Steuerbericht)

  // Letzter bekannter accrued-Award-Wert PRO Adresse, für den Plausibilitäts-Check im
  // Refresh-Intervall unten (verhindert, dass ein kurzzeitiger Daten-Aussetzer den Wert
  // scheinbar einbrechen lässt).
  const accruedAwardByAddrRef = useRef({});
  // Für die sekündliche, rein lokale Hochrechnung der laufend wachsenden Rewards zwischen zwei
  // echten Netzwerk-Abfragen: pro Adresse { value, atMs, ratePerMs } — der zuletzt real
  // gemessene Wert, wann er gemessen wurde, und die daraus abgeleitete Wachstumsrate pro
  // Millisekunde. Wird NUR fürs Hochzählen der Anzeige verwendet, nie für Netzwerk-Requests.
  const accruedRateRef = useRef({});
  // Aktualisiert accruedRateRef mit einem neu gemessenen ECHTEN Wert (von Liquify/THORNode) und
  // leitet daraus die Wachstumsrate pro Millisekunde für die lokale Sekunden-Hochrechnung ab.
  // Bei einem Rücksprung (z.B. weil gerade ein Churn ausgezahlt hat und der Zähler neu beginnt)
  // wird die Rate vorerst auf 0 gesetzt, bis der nächste echte Messwert wieder ein plausibles
  // Wachstum zeigt — sonst würde die Anzeige kurzzeitig rückwärts oder falsch hochzählen.
  const sampleAccruedRate = (addr, value) => {
    if (value == null) return;
    const now = Date.now();
    const prevSample = accruedRateRef.current[addr];
    if (!prevSample) {
      accruedRateRef.current[addr] = {
        value,
        atMs: now,
        ratePerMs: 0
      };
      return;
    }
    const elapsedMs = now - prevSample.atMs;
    // Rate NUR aus einem ausreichend großen Zeitfenster neu berechnen -- bei zu kurzem Abstand
    // zwischen zwei echten Messwerten (z.B. weil fetchPortfolio kurz hintereinander mehrfach
    // lief) würde schon eine winzige, ggf. nur durch Rundung bedingte Differenz auf "pro
    // Millisekunde" hochgerechnet eine absurd hohe Rate ergeben -- die tickende Anzeige würde
    // dann sekündlich sichtbar davonlaufen. Unterhalb der Mindestspanne wird der neue (korrekte)
    // Wert zwar übernommen, die bisherige Rate aber unverändert weiterverwendet.
    const MIN_SAMPLE_INTERVAL_MS = 60 * 1000;
    if (elapsedMs < MIN_SAMPLE_INTERVAL_MS) {
      accruedRateRef.current[addr] = {
        value,
        atMs: now,
        ratePerMs: prevSample.ratePerMs
      };
      return;
    }
    let ratePerMs = value >= prevSample.value && elapsedMs > 0 ? (value - prevSample.value) / elapsedMs : 0;
    // Zusätzliches Sicherheitsnetz: mehr als 1 RUNE/Sekunde Zuwachs (~86.400 RUNE/Tag) ist für
    // einen einzelnen Bond-Reward-Zähler unrealistisch -- so eine Rate kann nur aus einer
    // fehlerhaften Messung stammen, nie aus echtem Wachstum.
    const MAX_PLAUSIBLE_RATE_PER_MS = 1 / 1000;
    if (ratePerMs > MAX_PLAUSIBLE_RATE_PER_MS) ratePerMs = 0;
    accruedRateRef.current[addr] = {
      value,
      atMs: now,
      ratePerMs
    };
  };

  // Lädt aktuellen Bond + volle Bond/Unbond-Historie für eine beliebige Adresse. Gibt das
  // Ergebnis auch direkt zurück (nicht nur per State), damit Aufrufer sofort damit
  // weiterarbeiten können, ohne auf den nächsten Render warten zu müssen.
  // Lokaler Cache (im Browser) für das Bond-Rewards-Kärtchen: auch wenn die Historie im
  // rune-rewards-backend längst fertig aufgebaut ("done") ist, braucht ein FRISCH geöffneter Tab
  // trotzdem mindestens einen Netzwerk-Umweg (Balance/Bonded + Midgard-Bond-Ledger + Abfrage beim
  // Worker), bevor überhaupt etwas angezeigt werden kann — das ist die eigentliche Ursache für
  // die spürbare Verzögerung, nicht ein erneuter Aufbau der Historie. Um das Kärtchen trotzdem
  // gefühlt "sofort" zu öffnen, wird der zuletzt bekannte Stand hier im Browser zwischengespeichert
  // und beim Start direkt angezeigt, während im Hintergrund lautlos aktualisiert wird.
  const REWARD_CACHE_KEY = 'tp_reward_cache_v1';
  const loadRewardCacheFor = addr => {
    try {
      const raw = localStorage.getItem(REWARD_CACHE_KEY);
      if (!raw) return null;
      const all = JSON.parse(raw);
      return all[addr] || null;
    } catch (e) {
      return null;
    }
  };
  const saveRewardCacheFor = (addr, entry) => {
    try {
      const raw = localStorage.getItem(REWARD_CACHE_KEY);
      const all = raw ? JSON.parse(raw) : {};
      all[addr] = {
        ...(all[addr] || {}),
        ...entry,
        cachedAt: Date.now()
      };
      localStorage.setItem(REWARD_CACHE_KEY, JSON.stringify(all));
    } catch (e) {/* Speicher evtl. voll oder deaktiviert (privater Modus etc.) */}
  };
  const fetchNodeRewardsFor = async addr => {
    setNodeRewardsData(prev => ({
      ...prev,
      [addr]: {
        ...(prev[addr] || {}),
        loading: true,
        error: null
      }
    }));
    try {
      // fetchBondedRune (/balance) ist ein einzelner, schneller Request. fetchBondLedger
      // paginiert dagegen ggf. mehrfach durch Midgard-Aktionen und kann deutlich länger dauern.
      // Damit "Next reward" (braucht nur current+accruedAward, beides aus bondInfo) nicht
      // unnötig auf die langsamere Ledger-Abfrage warten muss, wird bondInfo NICHT mehr per
      // Promise.all abgewartet, sondern sobald verfügbar sofort in den State geschrieben --
      // die Ledger-abhängigen Felder (principal, transactions) folgen dann kurz danach nach.
      const ledgerPromise = fetchBondLedger(addr);
      const bondInfo = await fetchBondedRune(addr);
      accruedAwardByAddrRef.current[addr] = bondInfo.accruedAward;
      sampleAccruedRate(addr, bondInfo.accruedAward);
      setNodeRewardsData(prev => ({
        ...prev,
        [addr]: {
          ...(prev[addr] || {}),
          error: null,
          current: bondInfo.bonded,
          accruedAward: bondInfo.accruedAward,
          matchedNodeAddresses: bondInfo.matchedNodeAddresses || []
          // loading bleibt true -- der Ledger-Teil (principal/transactions, für die
          // Rewards-History gebraucht) ist noch nicht da.
        }
      }));
      const ledger = await ledgerPromise;
      // Alle Node-Adressen ever: aktuelle Treffer UND alle aus den Bond/Unbond-Transaktionen
      // selbst (deren Metadaten die Node-Adresse direkt enthalten) — deckt auch Nodes ab, von
      // denen die Adresse inzwischen komplett abgebonded hat und die daher in der aktuellen
      // Node-Liste nicht mehr auftauchen.
      const txNodeAddresses = (ledger.transactions || []).map(tx => tx.nodeAddress).filter(Boolean);
      const allNodeAddresses = Array.from(new Set([...(bondInfo.matchedNodeAddresses || []), ...txNodeAddresses]));
      if (!ledger.success) {
        const data = {
          loading: false,
          error: 'NO_LEDGER',
          errorDetail: ledger.errorDetail || null,
          current: bondInfo.bonded,
          principal: null,
          transactions: [],
          earliestDateMs: null,
          accruedAward: bondInfo.accruedAward,
          matchedNodeAddresses: bondInfo.matchedNodeAddresses || []
        };
        setNodeRewardsData(prev => ({
          ...prev,
          [addr]: data
        }));
        return data;
      }
      const data = {
        loading: false,
        error: null,
        current: bondInfo.bonded,
        principal: ledger.principal,
        transactions: ledger.transactions,
        earliestDateMs: ledger.earliestDateMs,
        accruedAward: bondInfo.accruedAward,
        matchedNodeAddresses: allNodeAddresses
      };
      setNodeRewardsData(prev => ({
        ...prev,
        [addr]: data
      }));
      saveRewardCacheFor(addr, {
        nodeReward: data
      });
      return data;
    } catch (e) {
      console.warn('[RUNE Portfolio] Rewards-Abruf komplett fehlgeschlagen für', addr, e);
      const data = {
        loading: false,
        error: 'FETCH_FAILED',
        errorDetail: e && (e.name ? `${e.name}: ${e.message}` : e.message) || String(e),
        current: null,
        principal: null,
        transactions: [],
        earliestDateMs: null,
        accruedAward: null,
        matchedNodeAddresses: []
      };
      setNodeRewardsData(prev => ({
        ...prev,
        [addr]: data
      }));
      return data;
    }
  };

  // Läuft, sobald mindestens eine Adresse mit Bond > 0 geladen wurde: holt für JEDE davon die
  // Bond-Historie + baut die automatische Reward-Historie aus allen relevanten Churns seit dem
  // ersten Bond-Datum auf. Adressen werden nacheinander abgearbeitet (nicht parallel), damit der
  // gemeinsame Lade-/Fortschrittsstatus einfach bleibt — bei den üblichen 1-3 Wallets kein
  // spürbarer Nachteil.
  //
  // Als eigene Funktion (nicht direkt im useEffect), damit sie sowohl beim Adresswechsel als
  // auch regelmäßig im Hintergrund (siehe Intervall weiter unten) aufgerufen werden kann, um
  // NEUE Churns automatisch zu erkennen — ohne dass die Seite neu geladen werden muss. Das ist
  // dabei billig: fetchChurnsList liefert bekannte Höhen aus dem Cache, und
  // buildAutoRewardHistory überspringt bereits bekannte Höhen automatisch (kein unnötiger
  // Netzwerk-Traffic, wenn seit dem letzten Lauf nichts Neues passiert ist).
  // Übernimmt eine neue Einträge-Liste für eine Adresse nur, wenn sie NICHT weniger Einträge hat
  // als der bisher bekannte Stand. bond_history_rows wird im Worker nie gelöscht, kann sich also
  // eigentlich nie verkleinern -- diese Sperre ist trotzdem eine bewusste Absicherung gegen jede
  // Art von zwischenzeitlich unvollständiger/inkonsistenter Backend-Antwort (z.B. während eines
  // Hintergrund-Refreshs), die sonst dazu führen würde, dass die Karte sichtbar auf "leer"
  // zurückspringt, bevor sie sich Sekunden später wieder auf den vollen Stand füllt.
  const mergeAutoRewardHistoryEntries = (prevHist, addr, newEntries) => {
    const prevEntries = prevHist[addr] || [];
    const nextEntries = newEntries.length >= prevEntries.length ? newEntries : prevEntries;
    if (newEntries.length < prevEntries.length) {
      console.warn('[RUNE Portfolio] Backend lieferte weniger Reward-Einträge als zuvor bekannt (', newEntries.length, '<', prevEntries.length, ') für', addr, '-- ignoriere, behalte alten Stand.');
    }
    return {
      ...prevHist,
      [addr]: nextEntries
    };
  };
  const runRewardsRefresh = async isCancelled => {
    if (!trackedAddresses.length) return;
    setAutoHistoryStatus(prev => prev === 'done' ? 'done' : 'loading'); // bei Hintergrund-Refresh nicht auf "loading" zurückspringen, wenn schon fertige Daten da sind
    setAutoHistoryProgress(null);
    try {
      // fetchNodeRewardsFor holt weiterhin den LIVE-Stand (aktueller Bond, aktuell aufgelaufener
      // Reward) für die schnelle sekündliche Hochrechnung oben in der UI — das bleibt bewusst
      // im Browser, da es sich um einen einzigen leichten Request pro Adresse handelt.
      // Die eigentliche, potenziell sehr aufwändige historische Reward-Historie kommt jetzt
      // komplett aus dem rune-rewards-backend (Cloudflare Worker), siehe buildAutoRewardHistory.
      let anyFailedCompletely = false;
      for (const addr of trackedAddresses) {
        if (isCancelled()) return;
        await fetchNodeRewardsFor(addr);
        if (isCancelled()) return;
        const {
          entries,
          status,
          errorDetail
        } = await buildAutoRewardHistory(addr, isCancelled, (partialEntries, backendData) => {
          if (isCancelled()) return;
          setAutoRewardHistory(prevHist => mergeAutoRewardHistoryEntries(prevHist, addr, partialEntries));
          setAutoHistoryProgress({
            done: partialEntries.length,
            total: null
          });
        });
        if (isCancelled()) return;
        setAutoRewardHistory(prevHist => mergeAutoRewardHistoryEntries(prevHist, addr, entries));
        if (status === 'done') {
          saveRewardCacheFor(addr, {
            autoRewardHistory: entries,
            autoHistoryDone: true
          });
        }
        if (status === 'error' || status === 'timeout') {
          console.warn(`[RUNE Portfolio] Reward-Historie vom Backend fehlgeschlagen für ${addr}:`, errorDetail || status);
          anyFailedCompletely = true;
        }
      }
      if (!isCancelled()) setAutoHistoryStatus(anyFailedCompletely ? 'error' : 'done');
    } catch (e) {
      console.warn('[RUNE Portfolio] Fehler beim Aufbau der Reward-Historie:', e);
      if (!isCancelled()) setAutoHistoryStatus('error');
    }
  };
  useEffect(() => {
    if (!trackedAddresses.length) return;
    // Sofort den zuletzt bekannten Stand aus dem lokalen Cache übernehmen (falls vorhanden) --
    // macht das Kärtchen gefühlt "sofort" sichtbar, statt für die Dauer des Netzwerk-Umwegs
    // (Balance/Bonded + Midgard-Ledger + Worker-Abfrage) einen leeren "Loading..."-Zustand zu
    // zeigen. Der eigentliche Netzwerk-Abgleich (runRewardsRefresh direkt im Anschluss) läuft
    // trotzdem ganz normal weiter und aktualisiert lautlos, falls sich seitdem etwas geändert hat.
    let hydratedHistoryDone = false;
    trackedAddresses.forEach(addr => {
      const cached = loadRewardCacheFor(addr);
      if (!cached) return;
      if (cached.nodeReward) {
        setNodeRewardsData(prev => prev[addr] ? prev : {
          ...prev,
          [addr]: {
            ...cached.nodeReward,
            loading: false
          }
        });
      }
      if (cached.autoRewardHistory) {
        setAutoRewardHistory(prev => prev[addr] ? prev : {
          ...prev,
          [addr]: cached.autoRewardHistory
        });
        if (cached.autoHistoryDone) hydratedHistoryDone = true;
      }
    });
    if (hydratedHistoryDone) setAutoHistoryStatus('done');
    let cancelled = false;
    runRewardsRefresh(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [trackedAddresses]);

  // Ein separates, selteneres Hintergrund-Intervall ist nicht mehr nötig -- fetchPortfolio läuft
  // bereits alle 60s automatisch (siehe weiter unten) und stößt runRewardsRefresh dabei direkt
  // mit an, deckt diesen Bedarf also schon ab, ohne eine zusätzliche, redundante Anfrage-Serie
  // zu benötigen.

  // Der aufgelaufene Reward wächst laufend mit jedem Block — deshalb separat und öfter
  // aktualisieren als die (teurere) volle Bond-Historie, ohne diese erneut abzufragen.
  useEffect(() => {
    accruedAwardByAddrRef.current = {}; // bei Adressänderung zurücksetzen
    accruedRateRef.current = {};
  }, [trackedAddresses]);
  useEffect(() => {
    if (!trackedAddresses.length) return;
    const refreshAccrued = async () => {
      for (const addr of trackedAddresses) {
        const bondInfo = await fetchBondedRune(addr);
        if (bondInfo.accruedAward == null) continue;
        accruedAwardByAddrRef.current[addr] = bondInfo.accruedAward;
        sampleAccruedRate(addr, bondInfo.accruedAward);
        setNodeRewardsData(p => p[addr] ? {
          ...p,
          [addr]: {
            ...p[addr],
            accruedAward: bondInfo.accruedAward
          }
        } : p);
      }
    };
    const id = setInterval(refreshAccrued, 60 * 1000);
    return () => clearInterval(id);
  }, [trackedAddresses, churnCountdown]);

  // Rein lokaler "Ticker": zwingt einmal pro Sekunde einen Re-Render, damit die unten
  // berechnete Hochrechnung (smoothAccruedAwardSum, siehe weiter unten) sichtbar mitläuft.
  // Löst KEINEN einzigen Netzwerk-Request aus — echte Daten kommen weiterhin nur alle 60s
  // (bzw. beim Adress-/Rewards-Refresh) von Liquify, siehe refreshAccrued oben.
  const [smoothTick, setSmoothTick] = useState(0);
  useEffect(() => {
    if (!trackedAddresses.length) return;
    const id = setInterval(() => setSmoothTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [trackedAddresses.length]);

  // Automatischer Retry mit Backoff, falls das Laden der Wallet-Daten fehlschlägt (z.B.
  // THORNode kurzzeitig nicht erreichbar) -- der Nutzer muss dafür NICHT selbst auf Refresh
  // klicken; siehe Einsatz im catch-Block von fetchPortfolio weiter unten.
  const portfolioRetryTimerRef = useRef(null);
  const portfolioRetryDelayRef = useRef(5000);
  const fetchPortfolioRef = useRef(null);
  const fetchPortfolio = useCallback(async walletsOverride => {
    const list = (walletsOverride || wallets).map(w => w.trim()).filter(Boolean);
    if (!list.length) return;
    setLoading(true);
    setError(null);

    // Wallet-Balance/Bonded (eigenes THORChain-Backend) und Preis/Chart (Binance/CoinGecko)
    // sind völlig unabhängige Datenquellen und dürfen sich deshalb nicht gegenseitig blockieren.
    // Früher lief der Preis-Teil ERST NACH einem erfolgreichen Wallet-Fetch, in derselben
    // try-Kette -- schlug die Wallet-Abfrage fehl, wurde der Preis-Teil nie erreicht, obwohl er
    // nichts mit Liquify/THORNode zu tun hat. Jetzt laufen beide parallel über Promise.allSettled.
    const fetchWalletData = async () => {
      // Balance + Bonded für JEDE Wallet einzeln abfragen (parallel), dann zu einer
      // Gesamtsumme zusammenzählen. Schlägt eine einzelne Wallet fehl, blockiert das nicht die
      // anderen — nur wenn ALLE fehlschlagen, wird ein Fehler angezeigt.
      const perWalletResults = await Promise.allSettled(list.map(async addr => {
        if (!addr.startsWith('thor1')) throw new Error(t('invalidAddress', lang));
        let balJson;
        try {
          balJson = await fetchBalanceWithFallback(addr);
        } catch (e) {
          if (e && e.message === 'NOT_FOUND') throw new Error(t('addressNotFound', lang));
          throw new Error(t('corsError', lang));
        }
        const runeEntry = (balJson.balances || []).find(b => b.denom === 'rune');
        const availableAmount = runeEntry ? parseInt(runeEntry.amount, 10) / 1e8 : 0;

        // Bonded RUNE separat abfragen — darf scheitern, ohne den Rest zu blockieren. Schlägt sie
        // fehl (Node-Liste kurzzeitig nicht erreichbar), NICHT auf 0 zurückfallen — sonst "zuckt"
        // Total RUNE bei jedem Refresh, sobald dieser eine Endpoint mal einen Aussetzer hat.
        const bondInfo = await fetchBondedRune(addr);
        const bondedAmount = bondInfo.bonded == null ? bondedByAddrRef.current[addr] ?? null : bondInfo.bonded;
        bondedByAddrRef.current[addr] = bondedAmount;
        balanceByAddrRef.current[addr] = availableAmount;
        // accruedAward kommt bewusst aus DERSELBEN Antwort wie bondedAmount (nicht aus der
        // separaten, unabhängig getimten fetchNodeRewardsFor-Abfrage) -- so sind Bonded und
        // Next Reward für die Portfolio-Gesamtsumme immer aus demselben Augenblick, statt dass
        // rund um einen Churn kurzzeitig sowohl der schon erhöhte Bonded-Wert ALS AUCH der noch
        // nicht zurückgesetzte alte Reward-Wert gleichzeitig einfließen (Reward würde sonst für
        // einen Moment doppelt gezählt).
        return {
          addr,
          availableAmount,
          bondedAmount: bondedAmount || 0,
          accruedAwardAtomic: bondInfo.accruedAward || 0,
          nodeBreakdown: bondInfo.nodeBreakdown || []
        };
      }));
      const succeeded = perWalletResults.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (!succeeded.length) {
        const firstError = perWalletResults.find(r => r.status === 'rejected');
        throw firstError && firstError.reason || new Error(t('genericError', lang));
      }
      const failedWallets = perWalletResults.map((r, i) => r.status === 'rejected' ? list[i] : null).filter(Boolean);
      if (failedWallets.length) {
        console.warn('[RUNE Portfolio] Diese Wallets konnten nicht geladen werden und wurden aus der Summe ausgelassen:', failedWallets);
      }
      const availableAmount = succeeded.reduce((s, r) => s + r.availableAmount, 0);
      const bondedAmount = succeeded.reduce((s, r) => s + r.bondedAmount, 0);
      const accruedAwardAtomicSum = succeeded.reduce((s, r) => s + (r.accruedAwardAtomic || 0), 0);

      // Bonded-Betrag pro Node über alle Wallets zusammenzählen (falls z.B. zwei eigene
      // Wallets an derselben Node bonden, werden die zu einer Zeile zusammengefasst).
      const nodeBreakdownMap = {};
      succeeded.forEach(r => {
        (r.nodeBreakdown || []).forEach(n => {
          if (!nodeBreakdownMap[n.nodeAddress]) nodeBreakdownMap[n.nodeAddress] = {
            nodeAddress: n.nodeAddress,
            status: n.status,
            bonded: 0
          };
          nodeBreakdownMap[n.nodeAddress].bonded += n.bonded;
        });
      });
      const combinedNodeBreakdown = Object.values(nodeBreakdownMap).sort((a, b) => b.bonded - a.bonded);
      const bondedWallets = succeeded.filter(r => r.bondedAmount > 0).map(r => r.addr);
      return {
        availableAmount,
        bondedAmount,
        accruedAwardAtomicSum,
        combinedNodeBreakdown,
        bondedWallets
      };
    };

    // Preis- und Chart-Daten sind gegenüber der eigentlichen Wallet-Info (Balance/Bonded von
    // THORNode) ein "Nice-to-have" und dürfen deren Anzeige nicht blockieren -- und umgekehrt.
    // Schlägt dieser Block fehl (z.B. Rate-Limit bei CoinGecko/Binance), wird das NICHT nach
    // oben geworfen -- stattdessen bleiben die zuletzt bekannten Preis-/Chart-Werte einfach
    // stehen und es wird nur ein dezenter Hinweis angezeigt.
    const fetchPriceAndChartData = async () => {
      let currentPrice = null;
      let currentAltPrice = null;
      let hist = null;
      let priceFetchFailed = false; // bezieht sich NUR auf den aktuellen Preis selbst
      let chartFetchFailed = false; // separat: nur die Verlaufs-Chart betreffend
      try {
        // RUNE-Preis (+ EURUSDT-Kurs für die Umrechnung) primär von Binance holen -- läuft
        // unabhängig davon, ob der Vergleichs-Coin dort überhaupt gelistet ist. Für
        // Nicht-USD/EUR-Währungen wird mit dem bereits vorhandenen FX-Kurs (frankfurter.app,
        // siehe localFxRateRef oben) umgerechnet.
        let localRate = 1;
        let runeFromBinance = null;
        let eurUsdtFromBinance = null;
        try {
          const binRes = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22RUNEUSDT%22%2C%22EURUSDT%22%5D');
          if (!binRes.ok) throw new Error('BINANCE_RUNE_FAIL');
          const binJson = await binRes.json();
          const getP = sym => {
            const entry = Array.isArray(binJson) ? binJson.find(x => x.symbol === sym) : null;
            return entry ? parseFloat(entry.price) : null;
          };
          runeFromBinance = getP('RUNEUSDT');
          eurUsdtFromBinance = getP('EURUSDT');
          if (runeFromBinance == null) throw new Error('BINANCE_RUNE_MISSING');
          if (currency === 'usd') localRate = 1;else if (currency === 'eur') {
            if (eurUsdtFromBinance == null) throw new Error('BINANCE_EUR_MISSING');
            localRate = 1 / eurUsdtFromBinance;
          } else {
            localRate = localFxRateRef.current; // von frankfurter.app befüllt (CoinGecko nur dessen Fallback)
          }
          currentPrice = {
            usd: runeFromBinance,
            local: runeFromBinance * localRate
          };
        } catch (runeErr) {
          const geckoRuneRes = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=thorchain&vs_currencies=usd,${currency}`);
          if (!geckoRuneRes.ok) throw runeErr;
          const geckoRuneJson = await geckoRuneRes.json();
          currentPrice = geckoRuneJson && geckoRuneJson.thorchain ? {
            usd: geckoRuneJson.thorchain.usd,
            local: geckoRuneJson.thorchain[currency]
          } : null;
          if (!currentPrice) throw runeErr;
        }

        // Vergleichs-Coin-Preis: Binance -> Kraken -> RUNE/Coin-Pool (Midgard) -> CoinGecko,
        // je nachdem, was für den gewählten Coin verfügbar ist (TCY läuft direkt über den
        // RUNE/TCY-Pool, RUJI über Kraken).
        let altHandled = false;
        if (altCoin.binanceSymbol) {
          try {
            const binRes = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${altCoin.binanceSymbol}`);
            if (!binRes.ok) throw new Error('BINANCE_ALT_FAIL');
            const binJson = await binRes.json();
            const altUsd = binJson && binJson.price != null ? parseFloat(binJson.price) : null;
            if (altUsd == null) throw new Error('BINANCE_ALT_MISSING');
            currentAltPrice = {
              usd: altUsd,
              local: altUsd * localRate
            };
            altHandled = true;
          } catch (e) {/* nächste Quelle probieren */}
        }
        if (!altHandled && altCoin.krakenPair) {
          try {
            const {
              usd: altUsd
            } = await fetchKrakenPrice(altCoin.krakenPair);
            currentAltPrice = {
              usd: altUsd,
              local: altUsd * localRate
            };
            altHandled = true;
          } catch (e) {/* nächste Quelle probieren */}
        }
        if (!altHandled && altCoin.poolAsset) {
          try {
            const {
              usd: altUsd
            } = await fetchThorchainPoolPrice(altCoin.poolAsset);
            currentAltPrice = {
              usd: altUsd,
              local: altUsd * localRate
            };
            altHandled = true;
          } catch (e) {/* nächste Quelle probieren */}
        }
        if (!altHandled) {
          const geckoAltRes = await fetchWithTimeout(`https://api.coingecko.com/api/v3/simple/price?ids=${altCoin.geckoId}&vs_currencies=usd,${currency}`);
          if (!geckoAltRes.ok) throw new Error('GECKO_ALT_FAIL');
          const geckoAltJson = await geckoAltRes.json();
          currentAltPrice = geckoAltJson && geckoAltJson[altCoin.geckoId] ? {
            usd: geckoAltJson[altCoin.geckoId].usd,
            local: geckoAltJson[altCoin.geckoId][currency]
          } : null;
          if (!currentAltPrice) throw new Error('GECKO_ALT_MISSING');
        }
      } catch (e) {
        console.warn('[RUNE Portfolio] Aktueller Preis konnte nicht geladen werden, zeige zuletzt bekannten Preis weiter:', e);
        priceFetchFailed = true;
      }

      // WICHTIG: bewusst ein SEPARATER try/catch-Block, NICHT Teil des obigen. Die Chart-Historie
      // kommt von CoinGecko und ist öffentlich recht streng rate-limitiert - schlägt NUR sie
      // fehl, soll das nicht mehr den bereits erfolgreich geladenen aktuellen Preis mit
      // unterdrücken.
      try {
        // Denselben (gecachten/deduplizierten) Abruf wie priceHistoryFull wiederverwenden,
        // statt eine zweite, redundante CoinGecko-Anfrage zu starten (siehe fetchPriceHistoryFullOnce).
        const fullHist = await fetchPriceHistoryFullOnce(currency);
        if (!fullHist) throw new Error('CHART_FAIL');
        const pricesUsd = fullHist.usd;
        const pricesLocal = fullHist.local;
        // WICHTIG: hier bewusst NUR die reinen Preise speichern, OHNE sie schon mit dem
        // aktuellen RUNE-Bestand zu einem Portfolio-Wert (valueUsd/valueLocal) zu verrechnen.
        // Preis/Chart und Wallet-Fetch laufen jetzt parallel (siehe oben) -- würde man hier
        // bereits mit totalAmount multiplizieren, bekäme der ALLERERSTE Chart-Aufruf noch den
        // initialen Wallet-Stand von 0 zu fassen (Wallet-Fetch war zu dem Zeitpunkt evtl. noch
        // nicht fertig) und der Chart würde bis zum nächsten Refresh-Zyklus komplett flach/leer
        // aussehen. Die Multiplikation mit dem RUNE-Bestand passiert stattdessen weiter unten in
        // filteredHistory, dort IMMER mit dem aktuell in React gehaltenen Balance+Bonded-Stand.
        hist = pricesUsd.map(([ts, pUsd], i) => {
          const pLocal = pricesLocal[i] ? pricesLocal[i][1] : pUsd; // Fallback, falls Arrays mal nicht exakt gleich lang sind
          return {
            date: ts,
            priceUsd: pUsd,
            priceLocal: pLocal
          };
        });
      } catch (e) {
        console.warn('[RUNE Portfolio] Preis-Chart-Historie konnte nicht geladen werden, zeige zuletzt bekannte Chart weiter:', e);
        chartFetchFailed = true;
      }
      return {
        currentPrice,
        currentAltPrice,
        hist,
        priceFetchFailed,
        chartFetchFailed
      };
    };
    const [priceSettled, walletSettled] = await Promise.allSettled([fetchPriceAndChartData(), fetchWalletData()]);

    // --- Preis/Chart-Teil auswerten (unabhängig vom Wallet-Ergebnis) ---
    if (priceSettled.status === 'fulfilled') {
      const {
        currentPrice,
        currentAltPrice,
        hist,
        priceFetchFailed,
        chartFetchFailed
      } = priceSettled.value;
      // Aktuellen Preis nur überschreiben, wenn DIESER Abruf diesmal erfolgreich war -- sonst
      // bleibt der vorherige (weiterhin gültige) Preis stehen, statt auf "leer" zu springen.
      if (!priceFetchFailed) {
        setPrice(currentPrice);
        setAltPrice(currentAltPrice);
      }
      if (!chartFetchFailed) {
        setHistory(hist);
      }
      if (!priceFetchFailed || !chartFetchFailed) {
        // Preis/Chart allein reicht schon aus, um das Dashboard anzuzeigen -- unabhängig davon,
        // ob die Wallet-Abfrage in diesem Zyklus geklappt hat.
        setHasData(true);
      }
      setPriceWarning(!priceFetchFailed && !chartFetchFailed ? null : t('priceDataError', lang));
    } else {
      setPriceWarning(t('priceDataError', lang));
    }

    // --- Wallet-Teil auswerten ---
    if (walletSettled.status === 'fulfilled') {
      const {
        availableAmount,
        bondedAmount,
        accruedAwardAtomicSum,
        combinedNodeBreakdown,
        bondedWallets
      } = walletSettled.value;
      setNodeBreakdown(combinedNodeBreakdown);
      setBalance(availableAmount);
      setBonded(bondedAmount);
      setAccruedForPortfolio(accruedAwardAtomicSum);
      // Läuft synchron mit jedem fetchPortfolio()-Zyklus (Start, Fokus-Wechsel, 60s-Auto-Refresh,
      // manueller Refresh) statt auf einem eigenen, unabhängigen Timer -- damit können "bonded"
      // (von hier) und "aufgelaufener Reward" (von dort) nicht mehr zeitlich auseinanderlaufen,
      // z.B. genau rund um einen Churn.
      runRewardsRefresh(() => false);
      setHasData(true);
      setLastUpdated(new Date());
      setError(null);
      // Erfolgreich geladen -> Backoff zurücksetzen und einen evtl. noch anstehenden
      // automatischen Retry-Versuch (aus einem vorherigen Fehlschlag) nicht mehr ausführen.
      portfolioRetryDelayRef.current = 5000;
      if (portfolioRetryTimerRef.current) {
        clearTimeout(portfolioRetryTimerRef.current);
        portfolioRetryTimerRef.current = null;
      }
      setAutoRetryPending(false);
      setTrackedAddresses(bondedWallets);
    } else {
      const e = walletSettled.reason;
      setError(e && e.message || t('genericError', lang));
      // Anders als früher: hasData wird HIER NICHT mehr zurückgesetzt. Hat entweder eine
      // vorherige Wallet-Abfrage oder der parallele Preis/Chart-Teil schon Daten geliefert,
      // bleibt das Dashboard sichtbar (mit den letzten bekannten Werten) und es kommt
      // zusätzlich ein Fehler-Banner dazu, statt dass die komplette Seite auf "leer" zurückfällt.
      // Automatisch erneut versuchen statt zu warten, bis der Nutzer selbst auf Refresh klickt --
      // mit steigendem Abstand (5s, 10s, 20s ... bis max. 60s), damit eine wirklich down-liegende
      // API nicht im Sekundentakt bestürmt wird. Läuft bereits ein Retry, wird der zuerst ersetzt.
      if (portfolioRetryTimerRef.current) clearTimeout(portfolioRetryTimerRef.current);
      const delay = portfolioRetryDelayRef.current;
      setAutoRetryPending(true);
      portfolioRetryTimerRef.current = setTimeout(() => {
        portfolioRetryDelayRef.current = Math.min(portfolioRetryDelayRef.current * 2, 60000);
        if (fetchPortfolioRef.current) fetchPortfolioRef.current();
      }, delay);
    }
    Promise.all([fetchVolume24h(), fetchVolumeHistory()]).then(([vol, hist]) => {
      setVolume24h(vol);
      setVolumeHistory(patchLastVolumeWithLive(hist, vol));
    });
    setLoading(false);
  }, [wallets, lang, fetchPriceHistoryFullOnce, altCoin, currency]);

  // fetchPortfolioRef zeigt immer auf die aktuellste Version (wichtig, damit der oben geplante
  // Retry-Timeout nicht mit veralteten wallets/currency/lang-Werten aus einem Schließungs-Snapshot
  // arbeitet). Der Timer selbst wird separat nur beim Unmount aufgeräumt (siehe darunter) --
  // NICHT hier, sonst würde jede Änderung von currency/lang/altCoin einen bereits geplanten
  // Retry versehentlich abbrechen.
  useEffect(() => {
    fetchPortfolioRef.current = fetchPortfolio;
  }, [fetchPortfolio]);
  useEffect(() => {
    return () => {
      if (portfolioRetryTimerRef.current) clearTimeout(portfolioRetryTimerRef.current);
    };
  }, []);

  // Wird die App aus dem Hintergrund/Standby geholt (z.B. schnelles Schließen und sofortiges
  // Wiederöffnen auf dem Handy) oder kommt die Netzwerkverbindung zurück, während gerade ein
  // Fehler-Banner mit Auto-Retry angezeigt wird, soll NICHT auf den nächsten Backoff-Schritt
  // (bis zu 60s) gewartet werden -- stattdessen sofort einen frischen Versuch starten.
  useEffect(() => {
    const retryNow = () => {
      if (document.visibilityState !== 'visible') return;
      if (portfolioRetryTimerRef.current) {
        clearTimeout(portfolioRetryTimerRef.current);
        portfolioRetryTimerRef.current = null;
      }
      portfolioRetryDelayRef.current = 5000;
      if (fetchPortfolioRef.current) fetchPortfolioRef.current();
    };
    document.addEventListener('visibilitychange', retryNow);
    window.addEventListener('focus', retryNow);
    window.addEventListener('online', retryNow);
    return () => {
      document.removeEventListener('visibilitychange', retryNow);
      window.removeEventListener('focus', retryNow);
      window.removeEventListener('online', retryNow);
    };
  }, []);

  // Regelmäßiges Auto-Refresh, auch wenn die Seite einfach offen bleibt (kein Tab-/App-Wechsel,
  // kein manueller Klick) -- bisher lief fetchPortfolio() nur beim Start, bei Fokuswechsel/
  // Sichtbarkeitsänderung oder manuell, weshalb Portfolio-Wert/Bonded/Next-Reward ohne aktives
  // Zutun eingefroren wirkten. 60s passt zum Rhythmus der übrigen periodischen Refreshs in der
  // App (FX-Kurs, 24h-Änderung, Accrued-Reward).
  useEffect(() => {
    if (!wallets.length) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible' && fetchPortfolioRef.current) {
        fetchPortfolioRef.current();
      }
    }, 60 * 1000);
    return () => clearInterval(id);
  }, [wallets.length]);

  // Beim Start automatisch laden, falls Wallets gespeichert sind.
  useEffect(() => {
    if (wallets.length) {
      fetchPortfolio();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Klick auf den Suchen/Hinzufügen-Button: ist eine Adresse eingetippt, wird sie der
  // Wallet-Liste hinzugefügt (falls neu) und die kombinierte Summe neu geladen; ist das Feld
  // leer, wird einfach die bestehende Liste aktualisiert (Refresh).
  const handleAddOrRefreshWallet = () => {
    const val = address.trim();
    if (val) {
      if (!val.startsWith('thor1')) {
        setError(t('invalidAddress', lang));
        return;
      }
      const newList = wallets.includes(val) ? wallets : [...wallets, val];
      setWallets(newList);
      setAddress('');
      fetchPortfolio(newList);
    } else {
      fetchPortfolio();
    }
  };
  const filteredHistory = useMemo(() => {
    const cutoff = Date.now() - range * 24 * 60 * 60 * 1000;
    // Portfolio-Wert wird HIER live aus Preis x aktuellem RUNE-Bestand berechnet (nicht mehr
    // vorab beim Fetch in valueUsd/valueLocal gespeichert) -- dadurch reagiert der Chart sofort
    // auf jede Änderung von balance/bonded, unabhängig davon, wann zuletzt neue Preisdaten
    // geladen wurden (siehe fetchPriceAndChartData weiter oben).
    const totalAmount = (balance || 0) + (bonded || 0);
    return history.filter(h => h.date >= cutoff).map(h => {
      const price = currency === 'usd' ? h.priceUsd : h.priceLocal;
      return {
        date: h.date,
        value: price != null ? price * totalAmount : null,
        price
      };
    });
  }, [history, range, currency, balance, bonded]);
  const activePrice = price ? currency === 'usd' ? price.usd : price.local : null;
  const activeAltPrice = altPrice ? currency === 'usd' ? altPrice.usd : altPrice.local : null;
  const runePriceStr = activePrice != null ? fmtUSDPrecise(activePrice, lang, currency) : '—';
  // Für das Chart-Modal: bei RUNE/BTC bzw. RUNE/ETH wird der Live-Ticker-Wert des jeweiligen
  // Paars angezeigt (nicht der Fiat-Preis) -- Format ohne Währungssymbol, mit Einheiten-Suffix.
  const runeModalActiveValue = runeQuote === 'USD' ? activePrice : runeQuoteLivePrice;
  const runeModalPriceStr = runeQuote === 'USD' ? runePriceStr : runeModalActiveValue == null ? '—' : runeQuote === 'BTC' ? `${fmtSats(runeModalActiveValue, lang)} sats` : `${fmtGwei(runeModalActiveValue, lang)} Gwei`;
  // Veränderung im geöffneten RUNE-Preis-Chart-Modal: bezogen auf den dort GEWÄHLTEN Zeitraum
  // (1D/7D/30D/90D/1Y), nicht fest auf 24h -- sonst zeigt die Prozentzahl beim Wechseln des
  // Zeitraums weiterhin nur die 24h-Änderung an, obwohl der Chart selbst z.B. 90 Tage zeigt.
  const runePriceRangeChangePct = runePriceHistory.length >= 1 && runeModalActiveValue != null && runePriceHistory[0].value ? (runeModalActiveValue - runePriceHistory[0].value) / runePriceHistory[0].value * 100 : null;
  const altPriceStr = activeAltPrice != null ? altCoin.code === 'BTC' ? fmtUSDRounded(activeAltPrice, lang, currency) : activeAltPrice.toLocaleString(localeFor(lang), {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) : '—';

  // Kombinierte Preis-Box: RUNE links, wählbarer Vergleichs-Coin rechts (Klick auf das Icon/den
  // Preis öffnet eine Auswahl aller von THORChain unterstützten Gas-Assets). Wird sowohl oben
  // (mobil) als auch in der Sidebar (Desktop) gerendert -- welche Variante sichtbar ist,
  // steuert CSS (siehe .tp-price-top / .tp-price-sidebar Media Query weiter oben im <style>-Block).
  const priceRowBox = (activePrice != null || activeAltPrice != null) && /*#__PURE__*/React.createElement("div", {
    className: "tp-side-card",
    style: {
      ...cardShellStyle,
      padding: '16px 18px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex'
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "tp-price-tile-btn",
    onClick: () => setShowRunePriceChart(true),
    title: t('viewPriceChart', lang),
    style: {
      flex: 1,
      minWidth: 0,
      paddingRight: 12,
      paddingLeft: 8,
      paddingTop: 6,
      paddingBottom: 6,
      margin: '-6px 0 -6px -8px',
      background: 'transparent',
      border: 'none',
      borderRadius: 10,
      textAlign: 'left',
      cursor: 'pointer',
      font: 'inherit',
      color: 'inherit',
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '0 0 auto',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      color: '#7C9698',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.03em',
      marginBottom: 8,
      fontFamily: "'Inter', sans-serif"
    }
  }, "RUNE", /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 15,
      height: 15,
      borderRadius: 4,
      background: 'rgba(0,222,225,0.16)',
      color: '#00DEE1',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(IconExpand, {
    size: 8
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tp-price-main",
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 19,
      lineHeight: 1.2,
      whiteSpace: 'nowrap'
    }
  }, runePriceStr), runeChange24h != null && /*#__PURE__*/React.createElement("div", {
    style: {
      color: runeChange24h >= 0 ? '#6FBF8F' : '#C97A7A',
      fontSize: 10.5,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      marginTop: 2
    }
  }, runeChange24h >= 0 ? '+' : '', runeChange24h.toFixed(2), "%")), /*#__PURE__*/React.createElement("div", {
    className: "tp-price-daily-chart",
    style: {
      flex: '0 0 200px',
      minWidth: 200,
      maxWidth: 200,
      height: 48,
      marginLeft: 38
    }
  }, /*#__PURE__*/React.createElement(MiniPriceSparkline, {
    data: runeDailyHistory,
    gradientId: "tpMiniSparkRune"
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      width: 1,
      background: '#1A3436',
      margin: '0 4px'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "tp-price-tile-btn tp-alt-price-btn",
    onClick: () => setShowCompareChart(true),
    title: t('viewCompareChart', lang),
    style: {
      flex: 1,
      minWidth: 0,
      paddingLeft: 8,
      paddingRight: 4,
      paddingTop: 6,
      paddingBottom: 6,
      margin: '-6px 0 -6px 0',
      background: 'transparent',
      border: 'none',
      borderRadius: 10,
      textAlign: 'left',
      cursor: 'pointer',
      font: 'inherit',
      color: 'inherit',
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '0 0 auto',
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      color: '#7C9698',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.03em',
      marginBottom: 8,
      fontFamily: "'Inter', sans-serif"
    }
  }, altCoin.code, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 15,
      height: 15,
      borderRadius: 4,
      background: 'rgba(0,222,225,0.16)',
      color: '#00DEE1',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement(IconExpand, {
    size: 8
  }))), /*#__PURE__*/React.createElement("div", {
    className: "tp-price-main",
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 19,
      lineHeight: 1.2,
      whiteSpace: 'nowrap'
    }
  }, altPriceStr), altChange24h != null && /*#__PURE__*/React.createElement("div", {
    style: {
      color: altChange24h >= 0 ? '#6FBF8F' : '#C97A7A',
      fontSize: 10.5,
      fontWeight: 600,
      whiteSpace: 'nowrap',
      marginTop: 2
    }
  }, altChange24h >= 0 ? '+' : '', altChange24h.toFixed(2), "%")), /*#__PURE__*/React.createElement("div", {
    className: "tp-price-daily-chart",
    style: {
      flex: '0 0 200px',
      minWidth: 200,
      maxWidth: 200,
      height: 48,
      marginLeft: 38
    }
  }, /*#__PURE__*/React.createElement(MiniPriceSparkline, {
    data: altDailyHistory,
    gradientId: "tpMiniSparkAlt"
  }))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setAltCoinPickerOpen(v => !v),
    title: t('tapChooseCoin', lang),
    style: {
      flexShrink: 0,
      marginTop: 1,
      width: 22,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 6,
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 10,
      padding: 0
    }
  }, "▾"))), altCoinPickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 6,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 6,
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 4,
      width: 200,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, ALT_COIN_OPTIONS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.code,
    onClick: () => {
      setAltCoinCode(c.code);
      setAltCoinPickerOpen(false);
    },
    title: c.label,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: c.code === altCoinCode ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: c.code === altCoinCode ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 8,
      padding: '8px 4px',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 700,
      fontFamily: "'Inter', sans-serif"
    }
  }, c.code))));

  // Aktive-Nodes-Anzeige (95 +12 -11 🔔). Wird sowohl in der mobilen Controls-Zeile
  // (neben Wallets/Per node) als auch -- nur auf Desktop -- rechtsbündig über der
  // Portfolio-Wert-Karte gerendert. Welche Variante sichtbar ist, steuert CSS
  // (siehe .tp-nodestats-mobile / .tp-nodestats-desktop Media Query im <style>-Block).
  const nodeStatsBox = nodeChurnStats && /*#__PURE__*/React.createElement("div", {
    className: "tp-controls-nodestats",
    style: {
      maxWidth: 420,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setNodeBellOpen(v => !v),
    title: t('nodeTooltip', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("span", null, nodeChurnStats.activeCount), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#8FE0AC',
      fontWeight: 700
    }
  }, "+", nodeChurnStats.joiningCount), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F0A0A0',
      fontWeight: 700
    }
  }, "-", nodeChurnStats.leavingCount), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'relative',
      display: 'inline-flex'
    }
  }, /*#__PURE__*/React.createElement(IconBell, {
    size: 13
  }), nodeWatchUnreadCount > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -6,
      right: -6,
      background: '#F0A0A0',
      color: '#1F0F0F',
      borderRadius: 999,
      fontSize: 9,
      fontWeight: 700,
      padding: '1px 4px',
      lineHeight: 1.4
    }
  }, nodeWatchUnreadCount)), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      fontSize: 9,
      transform: nodeBellOpen ? 'rotate(180deg)' : 'none'
    }
  }, "▾")), nodeBellOpen && /*#__PURE__*/React.createElement("div", {
    className: "tp-node-dropdown",
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 8,
      zIndex: 30,
      width: 'max-content',
      minWidth: 200,
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      background: '#0A1516',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-node-dropdown-stats",
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '4px 10px',
      fontSize: 10.5,
      color: '#7C9698',
      marginBottom: 2
    }
  }, /*#__PURE__*/React.createElement("span", null, nodeChurnStats.activeCount, " ", t('nodeActiveLabel', lang)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#8FE0AC'
    }
  }, nodeChurnStats.joiningCount, " ", t('nodesJoiningSuffixShort', lang)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F0A0A0'
    }
  }, nodeChurnStats.leavingCount, " ", t('nodesLeavingSuffixShort', lang))), nodeWatchNotifications.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 10.5,
      background: '#0D2022',
      border: '1px solid #232323',
      borderRadius: 7,
      padding: '6px 10px'
    }
  }, wallets.length === 0 ? t('nodeNoWalletHint', lang) : t('nodeNoChangesHint', lang)), nodeWatchNotifications.map(n => /*#__PURE__*/React.createElement("div", {
    key: n.id,
    style: {
      fontSize: 10.5,
      color: '#CBDBDC',
      background: '#0D2022',
      border: `1px solid ${n.variant === 'success' ? 'rgba(143,224,172,0.3)' : 'rgba(240,160,160,0.3)'}`,
      borderRadius: 7,
      padding: '5px 10px'
    }
  }, /*#__PURE__*/React.createElement("div", null, n.message), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 9,
      marginTop: 1
    }
  }, new Date(n.timestamp).toLocaleString(localeFor(lang))))), nodeWatchNotifications.length > 0 && /*#__PURE__*/React.createElement("button", {
    onClick: () => setNodeWatchNotifications(prev => prev.map(n => ({
      ...n,
      read: true
    }))),
    style: {
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 7,
      color: '#7C9698',
      fontSize: 10,
      padding: '4px 0',
      cursor: 'pointer'
    }
  }, t('nodeMarkAllRead', lang))));

  // Echte 200-TAGE-Linie für den RUNE-Preis-Übersichts-Chart: berechnet aus der ohnehin
  // geladenen vollständigen TÄGLICHEN Preishistorie (priceHistoryFull), nicht aus den Kerzen
  // des gerade gewählten Zeitraums -- die haben bei 7T/30T/90T oft weit weniger als 200
  // Punkte, wodurch eine "echte" 200-Tage-Linie dort nie erscheinen würde. So bleibt sie in
  // jedem Zeitraum sichtbar, sobald mindestens 200 Tage Preishistorie vorliegen.
  const rune200DayMA = useMemo(() => {
    const series = priceHistoryFull && priceHistoryFull.local;
    if (!series || series.length < 200) return [];
    const period = 200;
    const result = [];
    let sum = 0;
    for (let i = 0; i < series.length; i++) {
      sum += series[i][1];
      if (i >= period) sum -= series[i - period][1];
      if (i >= period - 1) result.push({
        date: series[i][0],
        value: sum / period
      });
    }
    return result;
  }, [priceHistoryFull]);

  // Einfacher RUNE-Preis-Übersichts-Chart, geöffnet durch Antippen der RUNE-Kachel oben.
  // Bewusst im selben visuellen Stil wie die Portfolio-Wert-Karte (cardShellStyle, gleiche
  // Typografie, gleiches Performance-Pill, gleiches Range-Picker-Muster) — aber als reines
  // Übersichts-Diagramm ohne Zeichenwerkzeuge, Zoom oder Verschieben.
  const runePriceChartModal = showRunePriceChart && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowRunePriceChart(false),
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.75)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      ...cardShellStyle,
      width: '100%',
      maxWidth: 860,
      maxHeight: '92vh',
      overflow: 'auto',
      padding: '22px 24px 22px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-flow",
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setRuneQuotePickerOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      background: 'transparent',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      color: '#96AEB0',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      fontFamily: "'Inter', sans-serif"
    }
  }, "RUNE / ", runeQuote, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 9,
      color: '#6C8688'
    }
  }, "▾")), runeQuotePickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 6,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 90,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, RUNE_QUOTE_OPTIONS.map(q => /*#__PURE__*/React.createElement("button", {
    key: q,
    onClick: () => {
      setRuneQuote(q);
      setRuneQuotePickerOpen(false);
    },
    style: {
      background: runeQuote === q ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: runeQuote === q ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '6px 10px',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, "RUNE/", q)))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowRunePriceChart(false),
    title: t('closeWord', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 7,
      width: 30,
      height: 30,
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 15,
      lineHeight: 1
    }
  }, "✕")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 40,
      lineHeight: 1.1,
      letterSpacing: '-0.01em'
    }
  }, runeModalPriceStr)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 18
    }
  }, runePriceRangeChangePct != null && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      color: runePriceRangeChangePct >= 0 ? '#8FE0AC' : '#F0A0A0',
      background: runePriceRangeChangePct >= 0 ? 'rgba(143,224,172,0.1)' : 'rgba(240,160,160,0.1)',
      border: `1px solid ${runePriceRangeChangePct >= 0 ? 'rgba(143,224,172,0.25)' : 'rgba(240,160,160,0.25)'}`,
      borderRadius: 999,
      padding: '4px 10px 4px 8px',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, runePriceRangeChangePct >= 0 ? /*#__PURE__*/React.createElement(IconUp, {
    size: 12
  }) : /*#__PURE__*/React.createElement(IconDown, {
    size: 12
  }), runePriceRangeChangePct >= 0 ? '+' : '', runePriceRangeChangePct.toFixed(2), "%"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6C8688',
      fontSize: 12
    }
  }, rangeLabel(runePriceChartRangeDays, lang))), /*#__PURE__*/React.createElement("div", {
    className: "tp-chart-card",
    style: {
      ...cardShellStyle,
      background: '#0B1A1C',
      padding: '16px 8px 8px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 10,
      right: 10,
      zIndex: 15
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setRunePriceRangePickerOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 3,
      background: '#0E2426',
      color: '#A0BABC',
      border: '1px solid #1A3436',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 10.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, rangeLabel(runePriceRangeDays, lang), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#6C8688'
    }
  }, "▾")), runePriceRangePickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 4,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 70,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, RUNE_PRICE_CHART_RANGES.map(d => /*#__PURE__*/React.createElement("button", {
    key: d,
    onClick: () => {
      setRunePriceRangeDays(d);
      setRunePriceRangePickerOpen(false);
    },
    style: {
      background: runePriceRangeDays === d ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: runePriceRangeDays === d ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '5px 8px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, rangeLabel(d, lang))))), runePriceHistory.length < 2 ? /*#__PURE__*/React.createElement("div", {
    style: {
      height: 340,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#7C9698',
      fontSize: 13
    }
  }, t('loading', lang)) : /*#__PURE__*/React.createElement("div", {
    key: `rune-price-${runeQuote}-${runePriceChartRangeDays}`,
    className: "tp-chart-fade-in"
  }, /*#__PURE__*/React.createElement(PortfolioChart, {
    data: runePriceHistory,
    lang: lang,
    currency: currency,
    storageKeyPrefix: `rune-price-${runeQuote}-${runePriceChartRangeDays}`,
    clampMinZero: false,
    height: typeof window !== 'undefined' && window.innerWidth < 640 ? 260 : 340,
    dateFormatter: runePriceChartRangeDays === 1 ? fmtHourMin : runePriceChartRangeDays > 365 ? fmtDateWithYear : fmtDate,
    allowMA200: runeQuote === 'USD',
    ma200OverrideSeries: runeQuote === 'USD' ? rune200DayMA : null,
    valueFormatter: runeQuote === 'USD' ? null : runeQuote === 'BTC' ? v => fmtSatsCompact(v) : v => fmtGweiCompact(v),
    allowZoom: true,
    allowRSI: true,
    allowVolume: true
  })), runeQuote !== 'USD' && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 10.5,
      marginTop: 8,
      fontFamily: "'Inter', sans-serif"
    }
  }, runeQuote === 'BTC' ? '1 BTC = 100.000.000 sats' : '1 ETH = 1.000.000.000 Gwei'))));

  // Vergleichs-Chart-Modal: RUNE gegen den aktuell gewählten Vergleichs-Coin (altCoin),
  // geöffnet durch Antippen der Coin-Kachel oben (nicht durch den kleinen ▾-Button daneben,
  // der bleibt ausschließlich für die Coin-Auswahl reserviert). Zwei normierte Linien
  // (Prozent-Performance seit Start des Zeitraums) zeigen unmittelbar, welcher Coin im
  // gewählten Fenster relativ stärker oder schwächer war.
  const isMarketcapCompare = altCoin.compareMode === 'marketcapPctOfRune';
  const compareRunePct = compareRuneHistory.length > 1 && compareRuneHistory[0].value ? (compareRuneHistory[compareRuneHistory.length - 1].value - compareRuneHistory[0].value) / compareRuneHistory[0].value * 100 : null;
  const compareAltPct = compareAltHistory.length > 1 && compareAltHistory[0].value ? (compareAltHistory[compareAltHistory.length - 1].value - compareAltHistory[0].value) / compareAltHistory[0].value * 100 : null;

  // Marketcap-Ratio-Modus (aktuell nur TCY): statt zweier normierter Performance-Linien wird
  // eine einzelne Linie berechnet: (altCoin-Preis × altCoin-Supply) / (RUNE-Preis × RUNE-Supply)
  // × 100, je Zeitpunkt der altCoin-Preisreihe (die RUNE-Seite wird per nächstgelegenem
  // bekannten Preis dazu-interpoliert, da beide Reihen unterschiedliche Zeitraster haben
  // können). RUNE-/TCY-Supply werden als über den Zeitraum konstant angenommen (beide ändern
  // sich nur sehr langsam), daher genügt der aktuell abgerufene Supply-Wert.
  const marketcapRatioSeries = useMemo(() => {
    if (!isMarketcapCompare) return [];
    if (!Number.isFinite(runeSupply) || !Number.isFinite(tcySupply) || runeSupply <= 0) return [];
    if (!compareAltHistory.length || !compareRuneHistory.length) return [];
    const sortedRune = [...compareRuneHistory].sort((a, b) => a.date - b.date);
    const findRuneAt = tsMs => {
      let lo = 0,
        hi = sortedRune.length - 1,
        best = sortedRune[0].value;
      while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (sortedRune[mid].date <= tsMs) {
          best = sortedRune[mid].value;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return best;
    };
    return [...compareAltHistory].sort((a, b) => a.date - b.date).map(d => {
      const runePriceAt = findRuneAt(d.date);
      if (!runePriceAt) return null;
      const tcyMcap = d.value * tcySupply;
      const runeMcap = runePriceAt * runeSupply;
      return {
        date: d.date,
        value: runeMcap > 0 ? tcyMcap / runeMcap * 100 : 0
      };
    }).filter(Boolean);
  }, [isMarketcapCompare, compareAltHistory, compareRuneHistory, runeSupply, tcySupply]);
  const marketcapRatioNow = marketcapRatioSeries.length ? marketcapRatioSeries[marketcapRatioSeries.length - 1].value : null;
  const compareChartModal = showCompareChart && /*#__PURE__*/React.createElement("div", {
    onClick: () => setShowCompareChart(false),
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      width: '100vw',
      height: '100vh',
      background: 'rgba(0,0,0,0.75)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      ...cardShellStyle,
      width: '100%',
      maxWidth: 860,
      maxHeight: '92vh',
      overflow: 'auto',
      padding: '22px 24px 22px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-flow",
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    }
  }, isMarketcapCompare ? /*#__PURE__*/React.createElement(React.Fragment, null, altCoin.code, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274'
    }
  }, t('marketcapPctVsRune', lang))) : /*#__PURE__*/React.createElement(React.Fragment, null, altCoin.code, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274'
    }
  }, t('compareVsRune', lang)))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setShowCompareChart(false),
    title: t('closeWord', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 7,
      width: 30,
      height: 30,
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 15,
      lineHeight: 1
    }
  }, "✕")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 18,
      flexWrap: 'wrap',
      marginBottom: 18
    }
  }, isMarketcapCompare ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: '50%',
      background: altCoin.color,
      display: 'inline-block'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#C3D5D6',
      fontSize: 12.5,
      fontWeight: 600
    }
  }, altCoin.code, " / RUNE ", t('marketcapWord', lang)), marketcapRatioNow != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F5A623',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, marketcapRatioNow.toFixed(marketcapRatioNow < 1 ? 3 : 2), "%")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: '50%',
      background: '#00DEE1',
      display: 'inline-block'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#C3D5D6',
      fontSize: 12.5,
      fontWeight: 600
    }
  }, "RUNE"), compareRunePct != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: compareRunePct >= 0 ? '#8FE0AC' : '#F0A0A0',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, compareRunePct >= 0 ? '+' : '', compareRunePct.toFixed(2), "%")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: '50%',
      background: altCoin.color,
      display: 'inline-block'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#C3D5D6',
      fontSize: 12.5,
      fontWeight: 600
    }
  }, altCoin.code), compareAltPct != null && /*#__PURE__*/React.createElement("span", {
    style: {
      color: compareAltPct >= 0 ? '#8FE0AC' : '#F0A0A0',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, compareAltPct >= 0 ? '+' : '', compareAltPct.toFixed(2), "%")))), /*#__PURE__*/React.createElement("div", {
    className: "tp-chart-card",
    style: {
      ...cardShellStyle,
      background: '#0B1A1C',
      padding: '16px 8px 8px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 10,
      right: 10,
      zIndex: 15
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setCompareRangePickerOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 3,
      background: '#0E2426',
      color: '#A0BABC',
      border: '1px solid #1A3436',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 10.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, rangeLabel(compareRangeDays, lang), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#6C8688'
    }
  }, "▾")), compareRangePickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 4,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 70,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, RUNE_PRICE_CHART_RANGES.map(d => /*#__PURE__*/React.createElement("button", {
    key: d,
    onClick: () => {
      setCompareRangeDays(d);
      setCompareRangePickerOpen(false);
    },
    style: {
      background: compareRangeDays === d ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: compareRangeDays === d ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '5px 8px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, rangeLabel(d, lang))))), isMarketcapCompare ? (compareHistoryLoading || !Number.isFinite(runeSupply) || !Number.isFinite(tcySupply)) && marketcapRatioSeries.length < 2 ? /*#__PURE__*/React.createElement("div", {
    style: {
      height: 340,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#7C9698',
      fontSize: 13
    }
  }, t('loading', lang)) : /*#__PURE__*/React.createElement(PercentRatioChart, {
    series: marketcapRatioSeries,
    color: altCoin.color,
    height: typeof window !== 'undefined' && window.innerWidth < 640 ? 260 : 340
  }) : compareHistoryLoading && (compareRuneHistory.length < 2 || compareAltHistory.length < 2) ? /*#__PURE__*/React.createElement("div", {
    style: {
      height: 340,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#7C9698',
      fontSize: 13
    }
  }, t('loading', lang)) : /*#__PURE__*/React.createElement(CompareLineChart, {
    seriesA: compareRuneHistory,
    seriesB: compareAltHistory,
    colorA: "#00DEE1",
    colorB: altCoin.color,
    height: typeof window !== 'undefined' && window.innerWidth < 640 ? 260 : 340
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 11,
      marginTop: 10,
      fontFamily: "'Inter', sans-serif"
    }
  }, isMarketcapCompare ? /*#__PURE__*/React.createElement(React.Fragment, null, t('marketcapPctVsRune', lang), " · ", rangeLabel(compareRangeDays, lang)) : /*#__PURE__*/React.createElement(React.Fragment, null, t('performanceLabel', lang), " · ", rangeLabel(compareRangeDays, lang)))));

  // Bond-Rewards-Karte für ALLE aktuell getrackten Wallet-Adressen zusammen (kombinierte Summe).
  const rewardsDataList = trackedAddresses.map(a => nodeRewardsData[a]).filter(Boolean);
  const hasAnyNodeRewardsData = rewardsDataList.length > 0;
  // Nur dann den vollflächigen "Loading..."-Platzhalter zeigen, wenn wirklich noch KEINE
  // brauchbaren Daten für irgendeine getrackte Adresse vorliegen (weder frisch geladen noch aus
  // dem lokalen Cache übernommen) -- ein Hintergrund-Refresh (alle 10 Min, oder der echte
  // Netzwerk-Abgleich direkt nach dem Cache-Hydrieren) markiert `loading: true`, soll das Kärtchen
  // aber NICHT mehr leeren, solange bereits ein zuletzt bekannter Stand angezeigt wird.
  const nodeRewardsLoading = hasAnyNodeRewardsData && rewardsDataList.some(d => d.loading) && !rewardsDataList.some(d => d.current != null || d.principal != null);
  const nodeRewardsLoaded = hasAnyNodeRewardsData && rewardsDataList.every(d => !d.loading);
  const nodeRewardsUsableEntries = rewardsDataList.filter(d => !d.loading && !d.error && d.current != null && d.principal != null);
  const nodeRewardsAllFailed = nodeRewardsLoaded && nodeRewardsUsableEntries.length === 0;

  // Automatisch rekonstruierte Einträge (aus THORNode-Höhenabfragen), über alle getrackten
  // Adressen zusammengefasst.
  const autoEventsAll = trackedAddresses.flatMap(a => autoRewardHistory[a] || []);

  // Historische Einträge (Datum, RUNE-Betrag, historischer Preis) — komplett automatisch,
  // keine manuelle Liste mehr nötig.
  const rewardOnlyEvents = autoEventsAll.map(ev => ({
    ...ev,
    priceUsd: priceHistoryFull ? findPriceAt(priceHistoryFull.usd, ev.dateMs) : null,
    priceLocal: priceHistoryFull ? findPriceAt(priceHistoryFull.local, ev.dateMs) : null
  })).filter(ev => ev.amount > 1e-9).sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));

  // Lädt eine Textdatei (hier: CSV) herunter -- auf Desktop-Browsern der klassische
  // Blob+Anchor-Trick, auf Mobilgeräten (v.a. iOS Safari) darüber aber oft unzuverlässig, weil
  // Safari den synthetischen Klick auf ein <a download> für Blob-URLs nicht immer verarbeitet.
  // Wo verfügbar wird stattdessen die Web-Share-API genutzt (navigator.share mit Datei) -- das
  // ist der Weg, den iOS Safari tatsächlich unterstützt und öffnet das native "Sichern/Teilen"-
  // Menü, worüber man die Datei z.B. in "Dateien" speichern kann.
  const downloadTextFile = async (filename, content, mimeType) => {
    const blob = new Blob([content], {
      type: `${mimeType};charset=utf-8;`
    });
    const file = new File([blob], filename, {
      type: mimeType
    });
    if (navigator.canShare && navigator.canShare({
      files: [file]
    })) {
      try {
        await navigator.share({
          files: [file]
        });
        return;
      } catch (e) {
        // Nutzer hat das Teilen-Menü abgebrochen, oder es schlug fehl -- dann normalen
        // Download-Weg als Fallback versuchen, statt einfach gar nichts zu tun.
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // CSV-Export der Rewards-Historie -- eine Zeile pro Reward-Event, chronologisch aufsteigend
  // (übliche Reihenfolge für den Import in Tabellenkalkulationen), mit Datum (ISO 8601, damit es
  // Excel/Sheets/Numbers eindeutig als Datum erkennen), Blockhöhe, RUNE-Betrag und -- falls zum
  // Zeitpunkt des Events ein historischer Preis bekannt ist -- USD-Preis und USD-Wert.
  const exportRewardsHistoryCsv = () => {
    const rows = [...rewardOnlyEvents].sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
    const header = ['date_utc', 'height', 'amount_rune', 'price_usd', 'value_usd'];
    const lines = [header.join(',')];
    for (const ev of rows) {
      const dateStr = ev.dateMs ? new Date(ev.dateMs).toISOString() : '';
      const priceUsd = ev.priceUsd != null ? ev.priceUsd : '';
      const valueUsd = ev.priceUsd != null ? ev.amount * ev.priceUsd : '';
      lines.push([dateStr, ev.height ?? '', ev.amount, priceUsd, valueUsd].join(','));
    }
    downloadTextFile(`bond-rewards-history-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
  };

  // Steuerbericht: eine Zeile pro Kalenderjahr statt pro Einzel-Event. Bewertet wird jedes Reward
  // zum Kurs im Moment des Zuflusses (priceLocal, historischer Preis in der gerade gewählten
  // Anzeigewährung) -- das ist der in den meisten Ländern (u.a. DE) maßgebliche Bewertungsansatz
  // für Krypto-Einkommen (Fair Market Value bei Zufluss), NICHT der heutige Kurs. Das Jahr wird
  // aus der lokalen Zeitzone des Browsers abgeleitet; wer über Silvester in einer anderen
  // Zeitzone war, sollte das im Hinterkopf behalten. Keine Steuerberatung -- reine Datenaufbereitung.
  const exportTaxReportCsv = () => {
    const byYear = new Map();
    for (const ev of rewardOnlyEvents) {
      if (!ev.dateMs) continue;
      const year = new Date(ev.dateMs).getFullYear();
      const entry = byYear.get(year) || {
        amount: 0,
        value: 0,
        count: 0,
        missingPrice: 0
      };
      entry.amount += ev.amount;
      entry.count += 1;
      if (ev.priceLocal != null) {
        entry.value += ev.amount * ev.priceLocal;
      } else {
        entry.missingPrice += 1;
      }
      byYear.set(year, entry);
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    const currencyCode = (currency || 'usd').toUpperCase();
    const lines = [t('taxReportCsvTitle', lang), `${t('taxReportCsvValuation', lang)}${currencyCode}.`, `${t('taxReportCsvCreatedAt', lang)}${new Date().toISOString()}`, '', ['tax_year', 'total_amount_rune', `total_value_${currency || 'usd'}`, 'number_of_events', 'events_without_price_data'].join(',')];
    for (const year of years) {
      const e = byYear.get(year);
      lines.push([year, e.amount, e.value, e.count, e.missingPrice].join(','));
    }
    downloadTextFile(`bond-rewards-tax-report-${new Date().toISOString().slice(0, 10)}.csv`, lines.join('\n'), 'text/csv');
  };

  // Gesamtsumme: AUSSCHLIESSLICH die exakte, per-Churn verifizierte Summe aus den historischen
  // Höhenabfragen (rewardOnlyEvents) — genau wie bei boonetools' rune_stack-Snapshots. Keine
  // "current_bond − principal"-Nährung mehr als Ersatz, da die bei Slashing oder unvollständiger
  // Midgard-Historie erheblich danebenliegen kann. Ist die Historie noch nicht fertig geladen,
  // zeigt die Karte das auch so an (kein falscher Ersatzwert).
  const autoHistorySum = rewardOnlyEvents.reduce((s, ev) => s + ev.amount, 0);
  // Wie bei der Liste selbst (siehe mergeAutoRewardHistoryEntries): sobald mindestens einmal
  // Einträge geladen wurden, wird die Summe daraus gezeigt -- unabhängig davon, ob
  // autoHistoryStatus GERADE in diesem Moment 'done' ist oder kurzzeitig wieder 'loading' (z.B.
  // weil runRewardsRefresh gerade neu gestartet ist, siehe [trackedAddresses]-Effekt). Beide
  // Anzeigen (Liste + Summe) sollen konsistent bleiben, statt dass die Summe verschwindet,
  // während die Liste darunter längst wieder vollständig sichtbar ist.
  const combinedRewardsRune = rewardOnlyEvents.length > 0 ? autoHistorySum : autoHistoryStatus === 'done' ? autoHistorySum : null;
  const combinedRewardsUsd = combinedRewardsRune != null && activePrice != null ? combinedRewardsRune * activePrice : null;

  // Diagnose-Log zum Abgleichen, falls die Summe nicht plausibel wirkt — nur im DevTools-
  // Log (F12) sichtbar, läuft nur wenn sich einer der Werte wirklich ändert (nicht bei jedem
  // Render / Preis-Tick), damit die Konsole nicht zugespamt wird.
  useEffect(() => {
    if (!trackedAddresses.length || !nodeRewardsLoaded) return;
    console.info('[RUNE Portfolio] Reward-Summe Diagnose', {
      addresses: trackedAddresses,
      totalCurrent: rewardsDataList.reduce((s, d) => s + (d.current || 0), 0),
      totalPrincipal: rewardsDataList.reduce((s, d) => s + (d.principal || 0), 0),
      autoHistorySum,
      autoHistoryStatus,
      autoEventsCount: autoEventsAll.length
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackedAddresses, nodeRewardsLoaded, autoHistorySum, autoEventsAll.length, autoHistoryStatus]);

  // Prognose für den nächsten Reward: NICHT aus dem statistischen Muster vergangener
  // Auszahlungen geschätzt, sondern live aus dem tatsächlichen, laufend wachsenden
  // current_award-Zähler von THORNode (siehe fetchBondedRune) — summiert über alle Wallets.
  // Das ist der Betrag, der beim nächsten Churn ausgezahlt wird, plus Countdown bis dahin.
  const accruedEntries = rewardsDataList.filter(d => d.accruedAward != null);
  const accruedAwardSum = accruedEntries.length ? accruedEntries.reduce((s, d) => s + d.accruedAward, 0) : null;
  // Rechnet den zuletzt ECHT gemessenen Wert pro Adresse mit ihrer bekannten Wachstumsrate bis
  // JETZT hoch (smoothTick sorgt für den sekündlichen Re-Render, siehe Ticker-Effekt oben) —
  // dadurch zählt die Anzeige jede Sekunde sichtbar hoch, ohne dass dafür Netzwerk-Requests
  // nötig sind. Fällt für eine Adresse ohne Rate-Sample einfach auf den letzten echten Wert
  // zurück (z.B. unmittelbar nach dem allerersten Laden).
  void smoothTick; // smoothTick selbst wird nicht gebraucht, erzwingt nur den sekündlichen Re-Render
  const smoothAccruedAwardSum = accruedEntries.length ? trackedAddresses.reduce((sum, addr) => {
    const sample = accruedRateRef.current[addr];
    if (sample) {
      const elapsedMs = Math.max(0, Date.now() - sample.atMs);
      return sum + sample.value + sample.ratePerMs * elapsedMs;
    }
    const fallback = nodeRewardsData[addr];
    return sum + (fallback && !fallback.loading && fallback.accruedAward || 0);
  }, 0) : null;
  const nextRewardForecast = accruedAwardSum != null ? {
    accruedAward: smoothAccruedAwardSum != null ? smoothAccruedAwardSum : accruedAwardSum,
    accruedAwardUsd: activePrice != null ? (smoothAccruedAwardSum != null ? smoothAccruedAwardSum : accruedAwardSum) * activePrice : null,
    nextChurnEstimateMs: churnCountdown ? churnCountdown.nextChurnEstimateMs : null,
    halted: churnCountdown ? !!churnCountdown.halted : false
  } : null;

  // Live-APY für den GERADE LAUFENDEN Churn -- 1:1 wie Boone.tools: PERSÖNLICH (nicht
  // netzwerkweit), aus dem eigenen accrued Reward und eigenem Bond der getrackten Adressen.
  // accruedAward hat die Node-Operator-Fee bereits abgezogen (siehe Worker: accruedAwardBase +=
  // ... * (1 - fee)) -- genau wie Boones "userAward = bondOwnershipPercentage * currentAward"
  // mit currentAward = current_award * (1 - nodeOperatorFee). Der Churn-Fortschritt
  // (progressedBlocks/totalBlocks/secondsPerBlock) ist netzwerkweit einheitlich -- das macht
  // Boone genauso (getChurnEstimateInput wird einmal global berechnet, nicht pro Node).
  const personalBondSum = accruedEntries.length ? rewardsDataList.reduce((s, d) => s + (d.current || 0), 0) : null;
  const liveChurnApy = accruedAwardSum != null && personalBondSum && churnCountdown && churnCountdown.totalBlocks > 0 ? estimateCurrentChurnYields({
    reward: smoothAccruedAwardSum != null ? smoothAccruedAwardSum : accruedAwardSum,
    principal: personalBondSum,
    progressedBlocks: churnCountdown.progressedBlocks,
    totalBlocks: churnCountdown.totalBlocks,
    secondsPerBlock: churnCountdown.secondsPerBlock || 6,
    lastChurnTimestamp: churnCountdown.lastChurnTimestampSec,
    churnIntervalSeconds: churnCountdown.totalBlocks * (churnCountdown.secondsPerBlock || 6)
  }) : null;

  // Angezeigte accrued Churn-Rewards für die Portfolio-Gesamtsumme: bewusst NICHT die für "Next
  // Reward" genutzte smoothAccruedAwardSum/accruedAwardSum (die kommt aus einer separaten,
  // unabhängig getimten Abfrage) -- sondern accruedForPortfolio, das atomar zusammen mit
  // "bonded" aus derselben Antwort stammt (siehe fetchPortfolio). Sonst könnte rund um einen
  // Churn kurzzeitig sowohl der schon erhöhte Bonded-Wert ALS AUCH der noch nicht
  // zurückgesetzte alte Reward-Wert gleichzeitig einfließen -> Reward würde für einen Moment
  // doppelt gezählt ("Total RUNE springt").
  const accruedForTotal = accruedForPortfolio != null ? accruedForPortfolio : 0;

  // Total RUNE = verfügbare Balance + gebondetes RUNE + bereits aufgelaufene (noch nicht
  // ausgezahlte) Churn-Rewards. Die accrued Rewards gehören wirtschaftlich schon dem Nutzer
  // (sie werden beim nächsten Churn automatisch dem Bond zugeschlagen), zählen aber erst seit
  // hier mit in die Portfolio-Übersicht/den Chart-Startwert hinein.
  const totalRune = balance != null ? balance + (bonded || 0) + accruedForTotal : null;
  const currentValue = totalRune != null && activePrice != null ? totalRune * activePrice : null;
  const rangeStartValue = filteredHistory[0] && filteredHistory[0].value;
  const rangeChangePct = currentValue != null && rangeStartValue ? (currentValue - rangeStartValue) / rangeStartValue * 100 : null;
  const isPositive = rangeChangePct != null && rangeChangePct >= 0;

  // Alle bekannten Bond-Reward-Ereignisse (aus allen getrackten Adressen) als flache Liste --
  // fließen unten als "kostenlose Käufe" (Preis 0) in die Ø-Kaufpreis-Berechnung mit ein.
  const allRewardEntries = useMemo(() => {
    // WICHTIG: rewardOnlyEvents statt der rohen autoRewardHistory verwenden -- dort hängt
    // bereits ein historischer priceUsd pro Event dran (aus der ohnehin geladenen
    // Preishistorie, siehe findPriceAt weiter oben). Genau diese Preise landen auch im
    // CSV-Export der Rewards-Historie, es braucht also KEINE zusätzliche externe Kursabfrage.
    return rewardOnlyEvents.filter(e => e && Number.isFinite(e.amount) && e.amount > 0 && Number.isFinite(e.dateMs));
  }, [rewardOnlyEvents]);


  // Gewichteter Durchschnittspreis über die "Average Cost Basis"-Methode: Käufe erhöhen
  // gehaltene Menge + Kostenbasis, Verkäufe reduzieren beides proportional zum Ø-Preis der
  // gehaltenen Menge zum Verkaufszeitpunkt. Bond-Rewards zählen als Käufe zum Preis 0 --
  // erhöhen also die gehaltene Menge, OHNE die Kostenbasis zu erhöhen, was den Ø-Kaufpreis
  // korrekt nach unten verdünnt (genau wie es wirtschaftlich sein sollte: geschenktes RUNE
  // senkt den Durchschnittspreis pro gehaltener Münze). "Investiert"/Ø-Kaufpreis beziehen sich
  // auf die AKTUELL noch gehaltene Menge, nicht auf alles jemals Gekaufte. Realisierter
  // Gewinn/Verlust aus Verkäufen wird separat mitgeführt.
  const purchaseStats = useMemo(() => {
    const rewardTx = allRewardEntries.map(e => ({
      date: e.dateMs,
      amount: e.amount,
      // e.priceUsd ist der historische Kurs zum Zeitpunkt des Reward-Zuflusses (siehe
      // rewardOnlyEvents). Kann null sein, falls für diesen Zeitpunkt kein Kurs vorliegt --
      // dann wie bei 'free' mit 0 bewerten, statt die Zeile ganz zu verlieren.
      priceUsd: rewardValuationMethod === 'market' && Number.isFinite(e.priceUsd) ? e.priceUsd : 0,
      type: 'buy',
      isReward: true
    }));
    const combined = [...purchases, ...rewardTx];
    if (!combined.length) return null;
    const sorted = combined.slice().sort((a, b) => a.date - b.date);
    let heldAmount = 0;
    let costBasis = 0;
    let realizedPnlUsd = 0;
    let everBoughtAmount = 0;
    let rewardAmountTotal = 0;
    if (costBasisMethod === 'fifo') {
      // FIFO: jeder Kauf wird als eigener "Posten" (Lot) mit Menge+Preis gemerkt. Ein Verkauf
      // baut die Posten der Reihe nach von VORNE (also die ältesten zuerst) ab, statt wie bei
      // der Durchschnittsmethode nur eine einzige Kostenbasis-Zahl proportional zu verringern.
      // Dadurch bleiben nach einem Verkauf gezielt die ZULETZT gekauften (teureren oder
      // günstigeren) Posten übrig -- der Ø-Preis der Restmenge kann sich also durch einen
      // Verkauf ändern, anders als bei der Durchschnittsmethode.
      const lots = [];
      for (const p of sorted) {
        const amt = Number(p.amount);
        const price = Number(p.priceUsd);
        if (!Number.isFinite(amt) || !Number.isFinite(price) || amt <= 0) continue;
        if (p.type === 'sell') {
          let remaining = amt;
          while (remaining > 1e-12 && lots.length) {
            const lot = lots[0];
            const consumed = Math.min(lot.amount, remaining);
            realizedPnlUsd += (price - lot.price) * consumed;
            lot.amount -= consumed;
            remaining -= consumed;
            if (lot.amount <= 1e-12) lots.shift();
          }
          // Rest von "remaining" (falls mehr verkauft als gehalten) wird ignoriert -- kann
          // nicht mehr verkaufen als gehalten, genau wie bei der Durchschnittsmethode.
        } else {
          lots.push({
            amount: amt,
            price
          });
          everBoughtAmount += amt;
          if (p.isReward) rewardAmountTotal += amt;
        }
      }
      for (const lot of lots) {
        heldAmount += lot.amount;
        costBasis += lot.amount * lot.price;
      }
    } else {
      // Durchschnittsmethode (Standard): siehe Kommentar oben der Funktion.
      for (const p of sorted) {
        const amt = Number(p.amount);
        const price = Number(p.priceUsd);
        if (!Number.isFinite(amt) || !Number.isFinite(price) || amt <= 0) continue;
        if (p.type === 'sell') {
          const sellAmt = Math.min(amt, heldAmount); // kann nicht mehr verkaufen als gehalten
          if (sellAmt <= 0) continue;
          const avgCostPerUnit = heldAmount > 0 ? costBasis / heldAmount : 0;
          realizedPnlUsd += (price - avgCostPerUnit) * sellAmt;
          costBasis -= avgCostPerUnit * sellAmt;
          heldAmount -= sellAmt;
        } else {
          heldAmount += amt;
          costBasis += amt * price;
          everBoughtAmount += amt;
          if (p.isReward) rewardAmountTotal += amt;
        }
      }
    }
    if (everBoughtAmount <= 0) return null;
    const totalAmount = heldAmount;
    const totalCostUsd = costBasis;
    const avgPriceUsd = totalAmount > 0 ? totalCostUsd / totalAmount : 0;
    return {
      totalAmount,
      totalCostUsd,
      avgPriceUsd,
      realizedPnlUsd,
      everBoughtAmount,
      rewardAmountTotal
    };
  }, [purchases, allRewardEntries, costBasisMethod, rewardValuationMethod]);
  // --- Chart-Höhe automatisch an das 24h-Volumen-Kärtchen angleichen ---
  // Statt eine feste Pixelhöhe zu raten (die je nach Schriftart, Sprache und Zeilenumbrüchen
  // nie exakt passt), wird die tatsächliche Höhe des Volumen-Kärtchens im Browser gemessen und
  // davon der "Rahmen" der Chart-Karte abgezogen (Innenabstand oben 16 + unten 8, Titelzeile
  // plus deren 10px Abstand nach unten). Übrig bleibt genau die Höhe, die der Chart bekommen
  // muss, damit beide Karten bündig abschließen. Ein ResizeObserver hält das aktuell, falls
  // sich der Inhalt des Volumen-Kärtchens ändert (z.B. Umschalten 7T/30T oder längere Zahlen).
  // Nur für die Desktop-Ansicht relevant -- unter 640px stapeln sich die Spalten untereinander,
  // dort gibt es nichts anzugleichen.
  const volCardRef = useRef(null);
  const chartTitleRef = useRef(null);
  const [matchedChartHeight, setMatchedChartHeight] = useState(null);
  const [matchedCardHeight, setMatchedCardHeight] = useState(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const compute = () => {
      if (window.innerWidth < 640) {
        setMatchedChartHeight(null);
        setMatchedCardHeight(null);
        return;
      }
      const volEl = volCardRef.current;
      const titleEl = chartTitleRef.current;
      if (!volEl || !titleEl) {
        setMatchedChartHeight(null);
        setMatchedCardHeight(null);
        return;
      }
      const volH = volEl.getBoundingClientRect().height;
      const titleH = titleEl.getBoundingClientRect().height;
      if (!volH || !titleH) return;
      const chrome = 16 + 8 + titleH + 10;
      const next = Math.round(volH - chrome);
      // Untergrenze als Sicherheitsnetz: sollte die Messung mal unsinnig klein ausfallen
      // (z.B. Kärtchen gerade ausgeblendet), lieber auf den statischen Standardwert zurückfallen.
      if (next >= 120) {
        setMatchedChartHeight(next);
        // Exakte Kartenhöhe zusätzlich als Inline-Stil setzen -- schlägt die CSS-Regel
        // .tp-chart-card { min-height: ... } aus index.html, damit die Karte weder von einem
        // zu hohen reservierten Mindestwert aufgebläht noch vom Chart selbst überdehnt wird.
        setMatchedCardHeight(Math.round(volH));
      } else {
        setMatchedChartHeight(null);
        setMatchedCardHeight(null);
      }
    };
    compute();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(compute) : null;
    if (ro && volCardRef.current) ro.observe(volCardRef.current);
    window.addEventListener('resize', compute);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', compute);
    };
  }, [volume24h, volumeHistory, activePrice, lang, currency, hideValue]);

  const purchaseTrackerBox = /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setPurchaseCardOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      height: 30,
      marginRight: 2,
      background: purchaseCardOpen ? 'rgba(0,222,225,0.14)' : 'transparent',
      border: `1px solid ${purchaseCardOpen ? 'rgba(0,222,225,0.55)' : '#1A3436'}`,
      borderRadius: 7,
      padding: '0 10px',
      color: purchaseCardOpen ? '#00DEE1' : '#96AEB0',
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap'
    }
  }, "Ø", purchaseStats ? ` ${fmtUSD(purchaseStats.avgPriceUsd, lang, 'usd')}` : '', /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#5C7274'
    }
  }, purchaseCardOpen ? '▴' : '▾')), purchaseCardOpen && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "tp-purchase-dropdown-backdrop",
    onClick: () => setPurchaseCardOpen(false)
  }), /*#__PURE__*/React.createElement("div", {
    className: "tp-purchase-dropdown-panel",
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 8,
      zIndex: 30,
      width: 320,
      maxWidth: '92vw',
      maxHeight: '80vh',
      overflowY: 'auto',
      boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
      borderRadius: 14
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-side-card",
    style: {
      ...cardShellStyle,
      padding: '14px 16px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: purchaseStats ? 8 : 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, t('avgBuyPrice', lang), purchasesSyncAddr && /*#__PURE__*/React.createElement("button", {
    onClick: manualSyncNow,
    disabled: purchasesSyncStatus === 'syncing',
    title: (purchasesSyncStatus === 'error' ? t('syncErrorHint', lang) : t('syncOkHint', lang)) + (syncDebugInfo ? ` (${t('syncServerCount', lang).replace('{n}', String(syncDebugInfo.remoteCount))})` : ''),
    style: {
      textTransform: 'none',
      fontWeight: 500,
      fontSize: 9.5,
      letterSpacing: 0,
      background: 'transparent',
      border: 'none',
      padding: 0,
      cursor: purchasesSyncStatus === 'syncing' ? 'default' : 'pointer',
      fontFamily: "'Inter', sans-serif",
      color: purchasesSyncStatus === 'error' ? '#C97A7A' : purchasesSyncStatus === 'syncing' ? '#7C9698' : '#5C9EA0',
      textDecoration: purchasesSyncStatus === 'syncing' ? 'none' : 'underline',
      textUnderlineOffset: 2
    }
  }, "· ", purchasesSyncStatus === 'syncing' ? t('syncStatusSyncing', lang) : purchasesSyncStatus === 'error' ? t('syncStatusError', lang) : t('syncStatusSynced', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("input", {
    ref: csvImportInputRef,
    type: "file",
    accept: ".csv,text/csv,text/plain,application/vnd.ms-excel",
    style: {
      display: 'none'
    },
    onChange: e => {
      const f = e.target.files && e.target.files[0];
      if (f) handlePurchaseCsvFile(f);
      e.target.value = '';
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => csvImportInputRef.current && csvImportInputRef.current.click(),
    disabled: purchaseImportLoading,
    title: purchaseImportLoading ? t('csvImportLoading', lang) : t('purchaseImportCsv', lang),
    style: {
      width: 20,
      height: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 5,
      color: purchaseImportLoading ? '#4C6062' : '#7C9698',
      cursor: purchaseImportLoading ? 'default' : 'pointer',
      fontSize: 11,
      padding: 0
    }
  }, purchaseImportLoading ? /*#__PURE__*/React.createElement(IconLoader, {
    size: 11
  }) : /*#__PURE__*/React.createElement(IconFileText, {
    size: 11
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditingPurchaseId(null);
      setPurchaseFormOpen(v => !v);
    },
    title: t('addPurchase', lang),
    style: {
      width: 20,
      height: 20,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: purchaseFormOpen ? 'rgba(0,222,225,0.16)' : 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 5,
      color: purchaseFormOpen ? '#00DEE1' : '#7C9698',
      cursor: 'pointer',
      fontSize: 14,
      fontWeight: 700,
      padding: 0,
      lineHeight: 1
    }
  }, "+"))), syncDebugInfo && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 9.5,
      color: '#4C6062',
      marginTop: -2,
      marginBottom: 6
    }
  }, t('syncServerCount', lang).replace('{n}', String(syncDebugInfo.remoteCount)), syncDebugInfo.updatedAt ? ` · ${new Date(syncDebugInfo.updatedAt).toLocaleString(localeFor(lang))}` : ''), purchaseStats ? /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 19,
      lineHeight: 1.2
    }
  }, fmtUSD(purchaseStats.avgPriceUsd, lang, 'usd'), purchaseStats.rewardAmountTotal > 0 && /*#__PURE__*/React.createElement("span", {
    title: t('includesRewardsShort', lang),
    style: {
      marginLeft: 8,
      verticalAlign: 'middle',
      display: 'inline-flex',
      alignItems: 'center',
      fontSize: 10,
      fontWeight: 700,
      color: '#00DEE1',
      background: 'rgba(0,222,225,0.14)',
      border: '1px solid rgba(0,222,225,0.35)',
      borderRadius: 999,
      padding: '3px 8px',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('includesRewardsShort', lang))), /*#__PURE__*/React.createElement("div", {
    title: t('costBasisMethodHint', lang),
    style: {
      display: 'inline-flex',
      gap: 2,
      marginTop: 6,
      background: '#0E2426',
      border: '1px solid #1A3436',
      borderRadius: 7,
      padding: 2
    }
  }, [{
    key: 'average',
    labelKey: 'costBasisAverage'
  }, {
    key: 'fifo',
    labelKey: 'costBasisFifo'
  }].map(opt => /*#__PURE__*/React.createElement("button", {
    key: opt.key,
    onClick: () => setCostBasisMethod(opt.key),
    style: {
      background: costBasisMethod === opt.key ? 'rgba(0,222,225,0.16)' : 'transparent',
      border: 'none',
      borderRadius: 5,
      color: costBasisMethod === opt.key ? '#00DEE1' : '#7C9698',
      fontWeight: 600,
      fontSize: 9.5,
      padding: '3px 8px',
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t(opt.labelKey, lang)))), purchaseStats.rewardAmountTotal > 0 && /*#__PURE__*/React.createElement("div", {
    title: t('rewardValuationHint', lang),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      marginTop: 6,
      marginLeft: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      gap: 2,
      background: '#0E2426',
      border: '1px solid #1A3436',
      borderRadius: 7,
      padding: 2
    }
  }, [{
    key: 'free',
    labelKey: 'rewardValuationFree'
  }, {
    key: 'market',
    labelKey: 'rewardValuationMarket'
  }].map(opt => /*#__PURE__*/React.createElement("button", {
    key: opt.key,
    onClick: () => setRewardValuationMethod(opt.key),
    style: {
      background: rewardValuationMethod === opt.key ? 'rgba(0,222,225,0.16)' : 'transparent',
      border: 'none',
      borderRadius: 5,
      color: rewardValuationMethod === opt.key ? '#00DEE1' : '#7C9698',
      fontWeight: 600,
      fontSize: 9.5,
      padding: '3px 8px',
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t(opt.labelKey, lang))))), rewardValuationMethod === 'free' && purchaseStats.rewardAmountTotal > 0 && purchaseStats.rewardAmountTotal >= purchaseStats.everBoughtAmount - 1e-6 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      padding: '6px 9px',
      background: 'rgba(217,164,65,0.08)',
      border: '1px solid rgba(217,164,65,0.28)',
      borderRadius: 7,
      fontSize: 10,
      color: '#C9A461',
      lineHeight: 1.45
    }
  }, t('rewardsOnlyZeroHint', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: '2px 12px',
      marginTop: 8,
      fontSize: 10.5,
      color: '#96AEB0'
    }
  }, /*#__PURE__*/React.createElement("div", null, t('currentlyHeld', lang), ": ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600
    }
  }, purchaseStats.totalAmount.toLocaleString(localeFor(lang), {
    maximumFractionDigits: 2
  }), " RUNE")), /*#__PURE__*/React.createElement("div", null, t('invested', lang), ": ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600
    }
  }, fmtUSDRounded(purchaseStats.totalCostUsd, lang, 'usd'))), activePrice != null && /*#__PURE__*/React.createElement("div", null, t('currentValueLabel', lang), ": ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600
    }
  }, fmtUSDRounded(purchaseStats.totalAmount * activePrice, lang, 'usd'))), purchaseStats.rewardAmountTotal > 0 && /*#__PURE__*/React.createElement("div", null, t('bondRewardsLabel', lang), ": ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#00DEE1',
      fontWeight: 600
    }
  }, "+", purchaseStats.rewardAmountTotal.toLocaleString(localeFor(lang), {
    maximumFractionDigits: 2
  }), " RUNE"))), activePrice != null && (() => {
    const pnl = purchaseStats.totalAmount * activePrice - purchaseStats.totalCostUsd;
    const pnlPct = purchaseStats.totalCostUsd > 0 ? pnl / purchaseStats.totalCostUsd * 100 : 0;
    const pos = pnl >= 0;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 4,
        fontSize: 11.5,
        fontWeight: 700,
        color: pos ? '#6FBF8F' : '#C97A7A'
      }
    }, t('profitLoss', lang), ": ", pos ? '+' : '', fmtUSDRounded(pnl, lang, 'usd'), " (", pos ? '+' : '', pnlPct.toFixed(1), "%)");
  })(), Math.abs(purchaseStats.realizedPnlUsd) >= 0.01 && (() => {
    const pos = purchaseStats.realizedPnlUsd >= 0;
    return /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 2,
        fontSize: 10.5,
        fontWeight: 600,
        color: pos ? '#6FBF8F' : '#C97A7A'
      }
    }, t('realizedPnl', lang), ": ", pos ? '+' : '', fmtUSDRounded(purchaseStats.realizedPnlUsd, lang, 'usd'));
  })(), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPurchaseListExpanded(v => !v),
    style: {
      marginTop: 8,
      background: 'transparent',
      border: 'none',
      color: '#5C9EA0',
      fontSize: 10.5,
      fontWeight: 600,
      cursor: 'pointer',
      padding: 0,
      fontFamily: "'Inter', sans-serif"
    }
  }, purchaseListExpanded ? t('hideHistory', lang) : t('showHistory', lang), " (", purchases.length, ")"), purchaseListExpanded && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 6,
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: cleanupDuplicatePurchases,
    style: {
      background: 'transparent',
      border: 'none',
      color: '#5C9EA0',
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
      padding: 0,
      fontFamily: "'Inter', sans-serif"
    }
  }, t('cleanupDuplicates', lang)), dedupeResultCount != null && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      color: dedupeResultCount > 0 ? '#6FBF8F' : '#7C9698'
    }
  }, dedupeResultCount > 0 ? t('duplicatesRemoved', lang).replace('{n}', String(dedupeResultCount)) : t('noDuplicatesFound', lang))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelectedPurchaseIds(selectedPurchaseIds.length === purchases.length ? [] : purchases.map(p => p.id)),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#5C9EA0',
      fontSize: 10,
      fontWeight: 600,
      cursor: 'pointer',
      padding: 0,
      fontFamily: "'Inter', sans-serif"
    }
  }, selectedPurchaseIds.length === purchases.length ? t('deselectAll', lang) : t('selectAll', lang))), selectedPurchaseIds.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginTop: 8,
      padding: '5px 7px',
      background: 'rgba(201,122,122,0.12)',
      border: '1px solid rgba(201,122,122,0.4)',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10.5,
      color: '#DCE7E8'
    }
  }, t('selectedCount', lang).replace('{n}', String(selectedPurchaseIds.length))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      alignItems: 'center',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelectedPurchaseIds([]),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      fontSize: 10.5,
      fontWeight: 600,
      cursor: 'pointer',
      padding: 0,
      fontFamily: "'Inter', sans-serif"
    }
  }, t('deselectAll', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDialog({
      message: t('confirmDeleteSelected', lang).replace('{n}', String(selectedPurchaseIds.length)),
      onConfirm: deleteSelectedPurchases
    }),
    style: {
      background: '#C97A7A',
      color: '#1A0A0A',
      border: 'none',
      borderRadius: 5,
      padding: '4px 9px',
      fontSize: 10.5,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('deleteSelected', lang)))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      maxHeight: 180,
      overflowY: 'auto'
    }
  }, purchases.slice().sort((a, b) => b.date - a.date).map(p => /*#__PURE__*/React.createElement("div", {
    key: p.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      fontSize: 10.5,
      padding: '5px 7px',
      background: selectedPurchaseIds.includes(p.id) ? 'rgba(0,222,225,0.10)' : '#0E2426',
      border: selectedPurchaseIds.includes(p.id) ? '1px solid rgba(0,222,225,0.4)' : '1px solid transparent',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: selectedPurchaseIds.includes(p.id),
    onChange: () => togglePurchaseSelected(p.id),
    style: {
      flexShrink: 0,
      width: 14,
      height: 14,
      cursor: 'pointer',
      accentColor: '#00DEE1'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: p.type === 'sell' ? '#C97A7A' : '#6FBF8F'
    }
  }, p.type === 'sell' ? '−' : '+'), Number(p.amount).toLocaleString(localeFor(lang), {
    maximumFractionDigits: 2
  }), " RUNE @ ", fmtUSD(p.priceUsd, lang, 'usd'), p.priceSource === 'estimated' && /*#__PURE__*/React.createElement("span", {
    title: t('estimatedPriceTooltip', lang),
    style: {
      marginLeft: 4,
      color: '#D9A441',
      fontWeight: 700,
      fontSize: 9.5
    }
  }, t('estimatedBadge', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 10
    }
  }, new Date(p.date).toLocaleDateString(localeFor(lang)), " · ", p.type === 'sell' ? t('txTypeSell', lang) : t('txTypeBuy', lang), " · ", purchaseSourceLabel(p.source, lang)))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 3,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditingPurchaseId(p.id);
      setPurchaseFormOpen(true);
    },
    title: t('editPurchase', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 11,
      padding: 2
    }
  }, /*#__PURE__*/React.createElement(IconPencil, {
    size: 11
  })), /*#__PURE__*/React.createElement("button", {
    onClick: () => deletePurchase(p.id),
    title: t('purchaseCancel', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#C97A7A',
      cursor: 'pointer',
      fontSize: 11,
      padding: 2
    }
  }, /*#__PURE__*/React.createElement(IconTrash, {
    size: 11
  })))))))) : !purchaseFormOpen && /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 11,
      lineHeight: 1.4,
      marginBottom: 8
    }
  }, t('noPurchasesHint', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setEditingPurchaseId(null);
      setPurchaseFormOpen(true);
    },
    style: {
      background: 'linear-gradient(135deg, #00DEE1, #00A8B0)',
      color: '#0A0A0A',
      border: 'none',
      borderRadius: 999,
      padding: '6px 14px',
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, "+ ", t('addPurchase', lang))), purchaseImportError && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 10.5,
      color: '#C97A7A'
    }
  }, purchaseImportError), purchaseFormOpen && /*#__PURE__*/React.createElement(PurchaseForm, {
    lang: lang,
    initial: editingPurchaseId ? purchases.find(p => p.id === editingPurchaseId) : null,
    onCancel: () => {
      setPurchaseFormOpen(false);
      setEditingPurchaseId(null);
    },
    onSave: entry => {
      addOrUpdatePurchase(entry);
      setPurchaseFormOpen(false);
      setEditingPurchaseId(null);
    }
  }), !purchaseStats && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      fontSize: 10,
      color: '#4C6062'
    }
  }, t('purchaseImportHint', lang)), importBatches.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10,
      paddingTop: 10,
      borderTop: '1px solid #16292B'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.03em',
      marginBottom: 6
    }
  }, t('importedFiles', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, importBatches.map(b => /*#__PURE__*/React.createElement("div", {
    key: b.id,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      fontSize: 10.5,
      padding: '5px 7px',
      background: '#0E2426',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#96AEB0',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      minWidth: 0
    }
  }, b.fileName, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274'
    }
  }, "(", b.count, ")")), /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDialog({
      message: t('confirmDeleteImport', lang).replace('{n}', String(b.count)),
      onConfirm: () => deleteImportBatch(b.id)
    }),
    title: t('deleteImport', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#C97A7A',
      cursor: 'pointer',
      fontSize: 11,
      padding: '2px 4px',
      flexShrink: 0,
      fontFamily: "'Inter', sans-serif"
    }
  }, /*#__PURE__*/React.createElement(IconTrash, {
    size: 11
  })))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      paddingTop: 8,
      borderTop: '1px solid #16292B'
    }
  },
  /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: '0.03em'
    }
  }, t('dexSuggestionsTitle', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setExtraAddressPanelOpen(v => !v),
    title: t('addSearchAddress', lang),
    style: {
      width: 22,
      height: 22,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: extraAddressPanelOpen ? 'rgba(0,222,225,0.16)' : 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 5,
      color: extraAddressPanelOpen ? '#00DEE1' : '#7C9698',
      cursor: 'pointer',
      fontSize: 13,
      fontWeight: 700,
      padding: 0,
      lineHeight: 1
    }
  }, "+")), extraAddressPanelOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 10,
      color: '#5C7274',
      marginBottom: 5,
      lineHeight: 1.4
    }
  }, t('extraSearchAddressHint', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 5
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    value: extraSearchAddressInput,
    onChange: e => setExtraSearchAddressInput(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter') addExtraSearchAddress();
    },
    placeholder: t('addSearchAddress', lang),
    style: {
      flex: 1,
      minWidth: 0,
      background: '#0E2426',
      border: '1px solid #1A3436',
      borderRadius: 6,
      padding: '5px 8px',
      color: '#DCE7E8',
      fontSize: 11,
      fontFamily: "'Inter', sans-serif",
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: addExtraSearchAddress,
    style: {
      background: 'rgba(0,222,225,0.16)',
      color: '#00DEE1',
      border: '1px solid #1A3436',
      borderRadius: 6,
      padding: '0 12px',
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, "+")), extraSearchAddresses.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: 'flex',
      flexWrap: 'wrap',
      gap: 4
    }
  }, extraSearchAddresses.map(a => /*#__PURE__*/React.createElement("div", {
    key: a,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: '#0E2426',
      border: '1px solid #1A3436',
      borderRadius: 5,
      padding: '3px 6px',
      fontSize: 10,
      color: '#96AEB0',
      maxWidth: '100%'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      maxWidth: 160
    }
  }, a), /*#__PURE__*/React.createElement("button", {
    onClick: () => removeExtraSearchAddress(a),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#C97A7A',
      cursor: 'pointer',
      fontSize: 11,
      padding: 0,
      lineHeight: 1,
      flexShrink: 0
    }
  }, "✕"))))),

  /* ---- Sektion 1: GENAU (On-Chain-Swaps) ---- */
  /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 8,
      padding: '7px 9px',
      background: 'rgba(111,191,143,0.06)',
      border: '1px solid rgba(111,191,143,0.25)',
      borderRadius: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    title: t('exactSuggestionsHint', lang),
    style: {
      color: '#6FBF8F',
      fontSize: 10.5,
      fontWeight: 700,
      letterSpacing: '0.03em',
      cursor: 'help'
    }
  }, t('exactSuggestionsTitle', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: fetchExactSwapSuggestions,
    disabled: suggestedPurchasesLoading,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flexShrink: 0,
      background: 'transparent',
      border: '1px solid rgba(111,191,143,0.4)',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 10.5,
      fontWeight: 600,
      color: suggestedPurchasesLoading ? '#4C6062' : '#6FBF8F',
      cursor: suggestedPurchasesLoading ? 'default' : 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, suggestedPurchasesLoading ? /*#__PURE__*/React.createElement(IconLoader, {
    size: 11
  }) : /*#__PURE__*/React.createElement(IconSearch, {
    size: 11
  }), suggestedPurchasesLoading ? t('searching', lang) : t('searchExactBuys', lang))), suggestedPurchasesError && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 5,
      fontSize: 10,
      color: '#96AEB0'
    }
  }, suggestedPurchasesError), suggestedPurchases.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      maxHeight: 150,
      overflowY: 'auto'
    }
  }, suggestedPurchases.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.txId,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      fontSize: 10.5,
      padding: '4px 6px',
      background: '#0E2426',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      display: 'flex',
      alignItems: 'baseline',
      gap: 5,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      flexShrink: 0
    }
  }, "+", s.runeAmount.toLocaleString(localeFor(lang), {
    maximumFractionDigits: 1
  }), " @ ", fmtUSD(s.priceUsd, lang, 'usd')), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274',
      fontSize: 9.5,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, new Date(s.dateMs).toLocaleDateString(localeFor(lang), {
    day: '2-digit',
    month: '2-digit'
  }), " · ", s.inputAsset ? s.inputAsset.replace('THOR.', '').replace('.', ' ') : t('purchaseSourceDex', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 3,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => acceptSuggestion(s),
    title: t('acceptSuggestion', lang),
    style: {
      background: 'rgba(111,191,143,0.16)',
      border: 'none',
      borderRadius: 5,
      color: '#6FBF8F',
      cursor: 'pointer',
      fontSize: 11,
      padding: '3px 5px',
      fontWeight: 700
    }
  }, "✓"), /*#__PURE__*/React.createElement("button", {
    onClick: () => dismissSuggestion(s),
    title: t('dismissSuggestion', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 11,
      padding: '3px 5px'
    }
  }, "✕")))))),

  /* ---- Sektion 2: UNGEFÄHR (Wallet-Eingänge / CEX-Auszahlungen) ---- */
  /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      padding: '7px 9px',
      background: 'rgba(217,164,65,0.06)',
      border: '1px solid rgba(217,164,65,0.25)',
      borderRadius: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    title: t('approxSuggestionsHint', lang),
    style: {
      color: '#D9A441',
      fontSize: 10.5,
      fontWeight: 700,
      letterSpacing: '0.03em',
      cursor: 'help'
    }
  }, t('approxSuggestionsTitle', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: fetchApproxTransferSuggestions,
    disabled: suggestedTransfersLoading,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      flexShrink: 0,
      background: 'transparent',
      border: '1px solid rgba(217,164,65,0.4)',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 10.5,
      fontWeight: 600,
      color: suggestedTransfersLoading ? '#4C6062' : '#D9A441',
      cursor: suggestedTransfersLoading ? 'default' : 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, suggestedTransfersLoading ? /*#__PURE__*/React.createElement(IconLoader, {
    size: 11
  }) : /*#__PURE__*/React.createElement(IconSearch, {
    size: 11
  }), suggestedTransfersLoading ? t('searching', lang) : t('searchApproxBuys', lang))), suggestedTransfersError && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 5,
      fontSize: 10,
      color: '#96AEB0'
    }
  }, suggestedTransfersError), suggestedTransfers.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6,
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      maxHeight: 150,
      overflowY: 'auto'
    }
  }, suggestedTransfers.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.txId,
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 6,
      fontSize: 10.5,
      padding: '4px 6px',
      background: '#0E2426',
      borderRadius: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      display: 'flex',
      alignItems: 'baseline',
      gap: 5,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#DCE7E8',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      flexShrink: 0
    }
  }, "+", s.runeAmount.toLocaleString(localeFor(lang), {
    maximumFractionDigits: 1
  }), " ≈ ", fmtUSD(s.priceUsd, lang, 'usd')), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274',
      fontSize: 9.5,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, new Date(s.dateMs).toLocaleDateString(localeFor(lang), {
    day: '2-digit',
    month: '2-digit'
  }), " · ", t('transferSourceLabel', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 3,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => acceptTransferSuggestion(s),
    title: t('acceptSuggestion', lang),
    style: {
      background: 'rgba(111,191,143,0.16)',
      border: 'none',
      borderRadius: 5,
      color: '#6FBF8F',
      cursor: 'pointer',
      fontSize: 11,
      padding: '3px 5px',
      fontWeight: 700
    }
  }, "✓"), /*#__PURE__*/React.createElement("button", {
    onClick: () => dismissTransferSuggestion(s),
    title: t('dismissSuggestion', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      cursor: 'pointer',
      fontSize: 11,
      padding: '3px 5px'
    }
  }, "✕"))))))), 
confirmDialog && ReactDOM.createPortal(/*#__PURE__*/React.createElement("div", {
    onClick: () => setConfirmDialog(null),
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 200,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: e => e.stopPropagation(),
    style: {
      ...cardShellStyle,
      padding: '20px 22px',
      maxWidth: 340,
      width: '100%'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#DCE7E8',
      fontSize: 13.5,
      lineHeight: 1.5,
      marginBottom: 18,
      fontFamily: "'Inter', sans-serif"
    }
  }, confirmDialog.message), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setConfirmDialog(null),
    style: {
      background: 'transparent',
      color: '#96AEB0',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: '8px 16px',
      fontSize: 12.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('purchaseCancel', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      confirmDialog.onConfirm();
      setConfirmDialog(null);
    },
    style: {
      background: '#C97A7A',
      color: '#1A0A0A',
      border: 'none',
      borderRadius: 8,
      padding: '8px 16px',
      fontSize: 12.5,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, t('confirmDeleteButton', lang))))), document.body)))));
  const nodeRewardsBox = hasAnyNodeRewardsData && /*#__PURE__*/React.createElement("div", {
    className: "tp-side-card tp-main-card",
    style: {
      ...cardShellStyle,
      padding: '22px 24px 22px',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-flow",
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2,
      borderRadius: '18px 18px 0 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      marginBottom: 18
    }
  }, t('bondRewards', lang)), nodeRewardsLoading && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 12
    }
  }, t('loading', lang)), !nodeRewardsLoading && nodeRewardsAllFailed && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F0A0A0',
      fontSize: 12
    }
  }, t('couldNotLoadRewardHistory', lang), (() => {
    // Zeigt das technische Detail des ersten Fehlschlags an (z.B. "Netzwerkfehler
    // (TypeError: Failed to fetch) bei gateway.liquify.com") — hilft beim gezielten
    // Debuggen, statt nur die generische Meldung zu sehen.
    const detail = rewardsDataList.map(d => d && d.errorDetail).find(Boolean);
    return detail ? /*#__PURE__*/React.createElement("div", {
      style: {
        color: '#7C9698',
        fontSize: 11,
        marginTop: 4,
        wordBreak: 'break-word'
      }
    }, detail) : null;
  })()), !nodeRewardsLoading && !nodeRewardsAllFailed && /*#__PURE__*/React.createElement(React.Fragment, null, nextRewardForecast && /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#0D2022',
      border: '1px solid #172E30',
      borderRadius: 12,
      padding: '14px 16px',
      marginBottom: 16
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 11,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.03em'
    }
  }, t('nextRewardLabel', lang)), nextRewardForecast.halted ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      color: '#F0A0A0',
      background: 'rgba(240,160,160,0.1)',
      border: '1px solid rgba(240,160,160,0.25)',
      borderRadius: 999,
      padding: '3px 9px 3px 7px',
      fontSize: 11,
      fontWeight: 700
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 5,
      height: 5,
      borderRadius: '50%',
      background: '#F0A0A0',
      display: 'inline-block'
    }
  }), t('churningHalted', lang)) : nextRewardForecast.nextChurnEstimateMs != null && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 11
    }
  }, '~', fmtCountdown(nextRewardForecast.nextChurnEstimateMs, lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 9,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F5F5F5',
      fontSize: 21,
      fontWeight: 700,
      fontFamily: "'Space Grotesk', sans-serif",
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, hideValue ? '••••' : /*#__PURE__*/React.createElement(React.Fragment, null, "+", fmtRune(nextRewardForecast.accruedAward, lang), /*#__PURE__*/React.createElement(IconRuneR, {
    size: 7,
    gradientId: "runeRGradForecast"
  }))), nextRewardForecast.accruedAwardUsd != null && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#A8D8B9',
      fontSize: 13.5
    }
  }, hideValue ? '••••' : `+${fmtUSD(nextRewardForecast.accruedAwardUsd, lang, currency)}`)), liveChurnApy && liveChurnApy.apy != null && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      paddingTop: 12,
      borderTop: '1px solid #172E30'
    }
  }, /*#__PURE__*/React.createElement("div", {
    title: t('networkApyExact', lang),
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      background: 'rgba(0,222,225,0.12)',
      border: '1px solid rgba(0,222,225,0.3)',
      borderRadius: 999,
      padding: '5px 12px 5px 9px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: '#00DEE1',
      display: 'inline-block',
      boxShadow: '0 0 6px rgba(0,222,225,0.8)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6FE3E5',
      fontSize: 10,
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.04em'
    }
  }, t('networkApyChurn', lang)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F5F5F5',
      fontWeight: 800,
      fontSize: 15,
      fontFamily: "'Space Grotesk', sans-serif"
    }
  }, fmtApyPercent(liveChurnApy.apy, lang))))), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 10.5,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      marginBottom: 6
    }
  }, t('totalRewardsLabel', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F5F5F5',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 18,
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      whiteSpace: 'nowrap'
    }
  }, hideValue ? '••••' : combinedRewardsRune != null ? /*#__PURE__*/React.createElement(React.Fragment, null, "+", fmtRune(combinedRewardsRune, lang)) : autoHistoryStatus === 'loading' ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#7C9698',
      fontFamily: "'Inter', sans-serif",
      fontWeight: 400
    }
  }, t('calculating', lang)) : '—'), combinedRewardsUsd != null && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      flexShrink: 0,
      color: '#8FE0AC',
      background: 'rgba(143,224,172,0.1)',
      border: '1px solid rgba(143,224,172,0.25)',
      borderRadius: 999,
      padding: '2px 8px',
      fontSize: 10.5,
      fontWeight: 700,
      whiteSpace: 'nowrap'
    }
  }, hideValue ? '••••' : `+${fmtUSD(combinedRewardsUsd, lang, currency)}`)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      marginBottom: rewardsListExpanded ? 4 : 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setRewardsListExpanded(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flex: 1,
      minWidth: 0,
      background: 'transparent',
      border: 'none',
      padding: 0,
      cursor: 'pointer',
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 600,
      fontSize: 11,
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      color: '#F5F5F5'
    }
  }, `${t('rewardsHistory', lang)} (${hideValue ? '••' : rewardOnlyEvents.length})`), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#7C9698',
      fontSize: 11,
      display: 'flex',
      alignItems: 'center',
      gap: 4
    }
  }, autoHistoryStatus === 'loading' && t('loading', lang), /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      transform: rewardsListExpanded ? 'rotate(180deg)' : 'none',
      transition: 'transform 0.15s'
    }
  }, "▾"))), rewardOnlyEvents.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flexShrink: 0,
      marginLeft: 8
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setExportMenuOpen(v => !v),
    title: t('exportMenuTitle', lang),
    "aria-label": t('exportMenuTitle', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      color: '#7C9698',
      border: '1px solid #1D3638',
      borderRadius: 6,
      padding: '4px 6px',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement(IconDownload, {
    size: 13
  })), exportMenuOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 4,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 210,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setExportMenuOpen(false);
      exportRewardsHistoryCsv();
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: 'transparent',
      color: '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '7px 9px',
      fontSize: 11.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left',
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement(IconDownload, {
    size: 13
  }), " ", t('downloadCsv', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setExportMenuOpen(false);
      exportTaxReportCsv();
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      background: 'transparent',
      color: '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '7px 9px',
      fontSize: 11.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left',
      whiteSpace: 'nowrap'
    }
  }, /*#__PURE__*/React.createElement(IconFileText, {
    size: 13
  }), " ", t('downloadTaxReport', lang))))), rewardsListExpanded && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#4C6062',
      fontSize: 10,
      marginBottom: 6
    }
  }, autoHistoryStatus === 'loading' && (autoHistoryProgress && autoHistoryProgress.total != null ? `${t('fetchingRewardHistory', lang)} (${autoHistoryProgress.done}/${autoHistoryProgress.total})` : autoHistoryProgress ? `${t('fetchingRewardHistory', lang)} (${autoHistoryProgress.done})` : t('fetchingRewardHistory', lang)), autoHistoryStatus === 'done' && `${autoEventsAll.length} ${t('allEntriesVerified', lang)}`, autoHistoryStatus === 'error' && t('totalAboveAccurate', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      maxHeight: 220,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      paddingRight: 4
    }
  }, rewardOnlyEvents.map((tx, i) => {
    const priceForCurrency = currency === 'usd' ? tx.priceUsd : tx.priceLocal;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        fontSize: 10.5,
        color: '#7C9698',
        padding: '3px 0',
        borderBottom: '1px solid #102224'
      }
    }, /*#__PURE__*/React.createElement("span", null, tx.dateMs ? new Date(tx.dateMs).toLocaleDateString(localeFor(lang), {
      day: '2-digit',
      month: 'short',
      year: '2-digit'
    }) : '—'), /*#__PURE__*/React.createElement("span", {
      style: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 5
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#F5F5F5'
      }
    }, hideValue ? '••••' : /*#__PURE__*/React.createElement(React.Fragment, null, "+", fmtRune(tx.amount, lang))), !hideValue && priceForCurrency != null && /*#__PURE__*/React.createElement("span", {
      style: {
        color: '#4C6062',
        fontSize: 9
      }
    }, t('atWord', lang), " ", fmtUSDPrecise(priceForCurrency, lang, currency))));
  }), rewardOnlyEvents.length === 0 && autoHistoryStatus === 'error' && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F0A0A0',
      fontSize: 11
    }
  }, t('couldNotVerifyIndividual', lang)), rewardOnlyEvents.length === 0 && autoHistoryStatus !== 'error' && autoHistoryStatus !== 'loading' && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#4C6062',
      fontSize: 11
    }
  }, t('noRewardEvents', lang))))));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100vh',
      background: 'radial-gradient(ellipse 900px 480px at 50% -8%, rgba(0, 222, 225, 0.14), transparent 62%), #000000',
      padding: '32px 20px',
      display: 'flex',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      maxWidth: 960
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 64,
      height: 64,
      borderRadius: 10,
      position: 'relative',
      overflow: 'visible',
      background: 'transparent',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      filter: 'drop-shadow(0 0 16px rgba(0, 222, 225, 0.65))'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: '100%',
      height: '100%',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement(IconBoltLogo, {
    size: 58,
    strokeWidth: 4.2
  }))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      lineHeight: 1.15
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'Unbounded', sans-serif",
      fontWeight: 700,
      fontSize: 15,
      letterSpacing: '0.01em',
      textTransform: 'uppercase',
      color: '#00DEE1',
      textShadow: '0 0 16px rgba(0, 222, 225, 0.5)'
    }
  }, "rune.watch"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#4C6062',
      fontSize: 10,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      fontFamily: "'Inter', sans-serif"
    }
  }, "Powered by Maxim"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setCurrencyPickerOpen(v => !v),
    title: t('changeCurrency', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      color: '#C0D4D6',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: '6px 12px',
      fontSize: 11,
      fontWeight: 700,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      letterSpacing: '0.03em',
      textTransform: 'uppercase'
    }
  }, currency, " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#7C9698'
    }
  }, "▾")), currencyPickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 6,
      zIndex: 30,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 6,
      maxHeight: 260,
      overflowY: 'auto',
      width: 180,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, CURRENCY_OPTIONS.map(c => /*#__PURE__*/React.createElement("button", {
    key: c.code,
    onClick: () => {
      setCurrency(c.code);
      try {
        localStorage.setItem('tp_currency', c.code);
      } catch (e) {}
      setCurrencyPickerOpen(false);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      background: currency === c.code ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: currency === c.code ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 6,
      padding: '6px 8px',
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("span", null, c.code.toUpperCase()), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274',
      fontSize: 10
    }
  }, c.symbol))))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setLangPickerOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      background: 'transparent',
      color: '#C0D4D6',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: '6px 12px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      letterSpacing: '0.03em'
    }
  }, lang.toUpperCase(), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#7C9698'
    }
  }, "▾")), langPickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 6,
      zIndex: 30,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 6,
      maxHeight: 280,
      overflowY: 'auto',
      width: 160,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, LANGUAGE_OPTIONS.map(l => /*#__PURE__*/React.createElement("button", {
    key: l.code,
    onClick: () => {
      setLang(l.code);
      try {
        localStorage.setItem('tp_lang', l.code);
      } catch (e) {}
      setLangPickerOpen(false);
    },
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      background: lang === l.code ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: lang === l.code ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 6,
      padding: '6px 8px',
      fontSize: 11,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, /*#__PURE__*/React.createElement("span", null, l.label), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#5C7274',
      fontSize: 9.5,
      textTransform: 'uppercase'
    }
  }, l.code)))))), wallets.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      marginBottom: 10,
      maxWidth: 420
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "tp-input",
    value: address,
    onChange: e => setAddress(e.target.value),
    onKeyDown: e => e.key === 'Enter' && handleAddOrRefreshWallet(),
    placeholder: "thor1...",
    spellCheck: false,
    autoCorrect: "off",
    autoCapitalize: "off",
    autoComplete: "off",
    style: {
      flex: 1,
      minWidth: 0,
      background: 'transparent',
      border: '1px solid #102224',
      borderRadius: 8,
      padding: '5px 9px',
      color: '#5C7274',
      fontSize: 10.5,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      letterSpacing: '-0.01em'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleAddOrRefreshWallet,
    disabled: loading || !address.trim(),
    style: {
      background: loading ? '#0E2426' : '#DCEAEB',
      color: loading ? '#7C9294' : '#000000',
      border: 'none',
      borderRadius: 8,
      padding: '0 12px',
      fontWeight: 600,
      fontSize: 11.5,
      fontFamily: "'Inter', sans-serif",
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      cursor: loading || !address.trim() ? 'default' : 'pointer',
      flexShrink: 0
    }
  }, loading ? /*#__PURE__*/React.createElement(IconLoader, {
    size: 13
  }) : /*#__PURE__*/React.createElement(IconSearch, {
    size: 13
  }), loading ? t('loading', lang) : t('searchWord', lang))), /*#__PURE__*/React.createElement("div", {
    className: "tp-controls-row",
    style: {
      display: 'flex',
      gap: 20,
      flexWrap: 'nowrap',
      marginBottom: 10,
      alignItems: 'flex-start',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-controls-left",
    style: {
      flex: '0 1 auto',
      maxWidth: 640,
      minWidth: 0,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      alignItems: 'flex-start',
      justifyContent: 'flex-start'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-controls-wallets",
    style: {
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      alignItems: 'flex-start'
    }
  }, wallets.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 420,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setWalletListExpanded(v => !v),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, t(typeof window !== 'undefined' && window.innerWidth < 640 ? 'addWalletsHeaderShort' : 'addWalletsHeader', lang), " (", wallets.length, ")", /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      fontSize: 9,
      transform: walletListExpanded ? 'rotate(180deg)' : 'none'
    }
  }, "▾")), walletListExpanded && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 6,
      zIndex: 30,
      width: 300,
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      background: '#0A1516',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 8
    }
  }, wallets.map(w => /*#__PURE__*/React.createElement("div", {
    key: w,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      background: '#0D2022',
      border: '1px solid #172E30',
      borderRadius: 6,
      padding: '4px 6px 4px 10px',
      fontSize: 10,
      fontFamily: "'JetBrains Mono', monospace",
      color: '#7C9698'
    }
  }, /*#__PURE__*/React.createElement("span", null, hideValue ? '••••••…•••••' : `${w.slice(0, 8)}…${w.slice(-5)}`), /*#__PURE__*/React.createElement("button", {
    onClick: () => removeWallet(w),
    title: t('removeWallet', lang),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#5C7274',
      cursor: 'pointer',
      fontSize: 13,
      lineHeight: 1,
      padding: '0 2px'
    }
  }, "×")))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "tp-input",
    value: address,
    onChange: e => setAddress(e.target.value),
    onKeyDown: e => e.key === 'Enter' && handleAddOrRefreshWallet(),
    placeholder: t('addAnotherWallet', lang),
    spellCheck: false,
    autoCorrect: "off",
    autoCapitalize: "off",
    autoComplete: "off",
    style: {
      flex: 1,
      minWidth: 0,
      background: 'transparent',
      border: '1px solid #102224',
      borderRadius: 8,
      padding: '5px 9px',
      color: '#5C7274',
      fontSize: 10.5,
      fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
      letterSpacing: '-0.01em'
    }
  }), /*#__PURE__*/React.createElement("button", {
    onClick: handleAddOrRefreshWallet,
    disabled: loading || !address.trim(),
    style: {
      background: loading ? '#0E2426' : '#DCEAEB',
      color: loading ? '#7C9294' : '#000000',
      border: 'none',
      borderRadius: 8,
      padding: '0 12px',
      fontWeight: 600,
      fontSize: 11.5,
      fontFamily: "'Inter', sans-serif",
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      cursor: loading || !address.trim() ? 'default' : 'pointer',
      flexShrink: 0
    }
  }, loading ? /*#__PURE__*/React.createElement(IconLoader, {
    size: 13
  }) : /*#__PURE__*/React.createElement(IconSearch, {
    size: 13
  }), loading ? t('loading', lang) : t('addWallet', lang))))), nodeBreakdown.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: 420,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setNodeBreakdownExpanded(v => !v),
    style: {
      background: 'transparent',
      border: 'none',
      color: '#7C9698',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      padding: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, t(typeof window !== 'undefined' && window.innerWidth < 640 ? 'showNodeBreakdownShort' : 'showNodeBreakdown', lang), " (", nodeBreakdown.length, ")", /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'inline-block',
      fontSize: 9,
      transform: nodeBreakdownExpanded ? 'rotate(180deg)' : 'none'
    }
  }, "▾")), nodeBreakdownExpanded && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      left: 0,
      marginTop: 6,
      zIndex: 30,
      width: 'max-content',
      minWidth: 200,
      maxWidth: 'calc(100vw - 32px)',
      boxSizing: 'border-box',
      background: '#0A1516',
      border: '1px solid #1A3436',
      borderRadius: 10,
      padding: 10,
      display: 'flex',
      flexDirection: 'column',
      gap: 4
    }
  }, nodeBreakdown.map(n => /*#__PURE__*/React.createElement("div", {
    key: n.nodeAddress,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      fontSize: 10.5,
      color: '#7C9698',
      background: '#0D2022',
      border: '1px solid #232323',
      borderRadius: 7,
      padding: '5px 10px'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "'JetBrains Mono', monospace",
      color: '#A0BABC'
    }
  }, n.nodeAddress.slice(0, 8), "…", n.nodeAddress.slice(-5)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#F5F5F5',
      fontWeight: 600,
      whiteSpace: 'nowrap'
    }
  }, hideValue ? '••••' : fmtRune(n.bonded, lang), " R"))))))), /*#__PURE__*/React.createElement("div", {
    className: "tp-nodestats-mobile"
  }, nodeStatsBox)), priceRowBox && /*#__PURE__*/React.createElement("div", {
    className: "tp-price-top",
    style: {
      marginTop: 10,
      marginBottom: 20
    }
  }, priceRowBox), error && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      background: '#1F0F0F',
      border: '1px solid #4A2A2A',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 24,
      color: '#F0A0A0',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement(IconAlert, null), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", null, error), autoRetryPending && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#C97A7A',
      fontSize: 11.5,
      marginTop: 3
    }
  }, t('autoRetrying', lang)))), !error && hasData && priceWarning && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      background: '#1F1B0F',
      border: '1px solid #4A3F2A',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 24,
      color: '#E0C080',
      fontSize: 13
    }
  }, /*#__PURE__*/React.createElement(IconAlert, null), /*#__PURE__*/React.createElement("span", null, priceWarning)), !hasData && !loading && !error && /*#__PURE__*/React.createElement("div", {
    style: {
      border: '1px dashed #1A3436',
      borderRadius: 14,
      padding: '40px 20px',
      textAlign: 'center',
      color: '#7C9698',
      fontSize: 13
    }
  }, t('enterAddressPrompt', lang)), !hasData && nodeRewardsBox && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      justifyContent: 'flex-end',
      marginTop: 20
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: '1 1 240px',
      maxWidth: 300,
      minWidth: 240
    }
  }, nodeRewardsBox)), hasData && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "tp-mobile-tabs",
    style: {
      gap: 8,
      marginBottom: 12
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setMobileTab('chart'),
    style: {
      flex: 1,
      minWidth: 0,
      background: mobileTab === 'chart' ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: mobileTab === 'chart' ? '#00DEE1' : '#7C9698',
      border: `1px solid ${mobileTab === 'chart' ? 'rgba(0,222,225,0.55)' : '#1A3436'}`,
      borderRadius: 8,
      padding: '8px 6px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, t('chartTab', lang)), /*#__PURE__*/React.createElement("button", {
    onClick: () => setMobileTab('details'),
    style: {
      flex: 1,
      minWidth: 0,
      background: mobileTab === 'details' ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: mobileTab === 'details' ? '#00DEE1' : '#7C9698',
      border: `1px solid ${mobileTab === 'details' ? 'rgba(0,222,225,0.55)' : '#1A3436'}`,
      borderRadius: 8,
      padding: '8px 6px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, t('detailsTab', lang))), /*#__PURE__*/React.createElement("div", {
    className: "tp-content-row",
    style: {
      display: 'flex',
      gap: 20,
      alignItems: 'flex-start',
      flexWrap: 'wrap',
      touchAction: 'pan-y',
      overscrollBehaviorX: 'none'
    },
    onTouchStart: handleContentTouchStart,
    onTouchEnd: handleContentTouchEnd
  }, /*#__PURE__*/React.createElement("div", {
    className: `tp-chart-panel ${mobileTab === 'chart' ? 'tp-panel-active' : ''}`,
    style: {
      flex: '1 1 420px',
      minWidth: 0,
      maxWidth: 640
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-main-card",
    style: {
      ...cardShellStyle,
      padding: '22px 24px 22px',
      marginBottom: 20,
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "tp-flow",
    style: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 2,
      borderRadius: '18px 18px 0 0'
    }
  }), /*#__PURE__*/React.createElement("div", {
    className: "tp-main-card-header",
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      marginBottom: 18
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    }
  }, t('portfolioValue', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      flexShrink: 0
    }
  }, purchaseTrackerBox, /*#__PURE__*/React.createElement("button", {
    onClick: () => setHideValue(v => !v),
    title: hideValue ? t('showValues', lang) : t('hideValues', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 7,
      width: 30,
      height: 30,
      color: '#7C9698',
      cursor: 'pointer'
    }
  }, hideValue ? /*#__PURE__*/React.createElement(IconEyeOff, null) : /*#__PURE__*/React.createElement(IconEye, null)), /*#__PURE__*/React.createElement("button", {
    onClick: () => fetchPortfolio(),
    disabled: loading,
    title: t('refreshWord', lang),
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'transparent',
      border: '1px solid #1A3436',
      borderRadius: 7,
      width: 30,
      height: 30,
      color: '#7C9698',
      cursor: loading ? 'default' : 'pointer'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      animation: loading ? 'spin 0.8s linear infinite' : 'none'
    }
  }, /*#__PURE__*/React.createElement(IconRefresh, {
    size: 13
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 40,
      lineHeight: 1.1,
      letterSpacing: '-0.01em'
    }
  }, hideValue ? '••••••' : fmtUSD(currentValue, lang, currency))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
      marginBottom: 18
    }
  }, rangeChangePct != null && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 5,
      color: isPositive ? '#8FE0AC' : '#F0A0A0',
      background: isPositive ? 'rgba(143,224,172,0.1)' : 'rgba(240,160,160,0.1)',
      border: `1px solid ${isPositive ? 'rgba(143,224,172,0.25)' : 'rgba(240,160,160,0.25)'}`,
      borderRadius: 999,
      padding: '4px 10px 4px 8px',
      fontSize: 12.5,
      fontWeight: 700
    }
  }, isPositive ? /*#__PURE__*/React.createElement(IconUp, {
    size: 12
  }) : /*#__PURE__*/React.createElement(IconDown, {
    size: 12
  }), isPositive ? '+' : '', rangeChangePct.toFixed(2), "%"), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6C8688',
      fontSize: 12
    }
  }, rangeLabel(range, lang))), bonded === null && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 11,
      marginTop: 10
    }
  }, t('bondedNoteBefore', lang), " ", /*#__PURE__*/React.createElement(IconRuneR, {
    size: 4,
    gradientId: "runeRGradNote"
  }), " ", t('bondedNoteAfter', lang)), totalRune != null && /*#__PURE__*/React.createElement("div", {
    className: "tp-totals-row",
    style: {
      display: 'flex',
      gap: 10,
      paddingTop: 16,
      borderTop: '1px solid #232323'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: '#0D2022',
      border: '1px solid #172E30',
      borderRadius: 12,
      padding: '10px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 10.5,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      marginBottom: 4
    }
  }, t('totalRuneWord', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F5F5F5',
      fontSize: 15,
      fontWeight: 600,
      fontFamily: "'Space Grotesk', sans-serif",
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, hideValue ? '••••' : fmtRune(totalRune, lang), /*#__PURE__*/React.createElement(IconRuneR, {
    size: 5,
    gradientId: "runeRGradTotalTile"
  }))), bonded != null && bonded > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      background: '#0D2022',
      border: '1px solid #172E30',
      borderRadius: 12,
      padding: '10px 14px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#7C9698',
      fontSize: 10.5,
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.03em',
      marginBottom: 4
    }
  }, "Bonded"), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#F5F5F5',
      fontSize: 15,
      fontWeight: 600,
      fontFamily: "'Space Grotesk', sans-serif",
      display: 'flex',
      alignItems: 'center',
      gap: 5
    }
  }, hideValue ? '••••' : fmtRune(bonded, lang), /*#__PURE__*/React.createElement(IconRuneR, {
    size: 5,
    gradientId: "runeRGradBondedTile"
  })))), lastUpdated && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#4C6062',
      fontSize: 11,
      marginTop: 14,
      display: 'flex',
      alignItems: 'center',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", null, t('lastUpdated', lang), lastUpdated.toLocaleTimeString(localeFor(lang), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })), liveConnected && /*#__PURE__*/React.createElement("span", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      color: '#3DDC84'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: '#3DDC84',
      animation: 'pulse 1.6s ease-in-out infinite'
    }
  }), t('liveWord', lang)))), /*#__PURE__*/React.createElement("div", {
    className: "tp-chart-card",
    style: {
      ...cardShellStyle,
      background: '#0B1A1C',
      padding: '16px 8px 8px',
      position: 'relative',
      // Wenn zur Laufzeit am 24h-Volumen-Kärtchen gemessen wurde: exakt dessen Höhe übernehmen.
      // Der Inline-Stil schlägt die .tp-chart-card-Regel (min-height) aus index.html.
      ...(matchedCardHeight != null ? {
        height: matchedCardHeight,
        minHeight: matchedCardHeight
      } : null)
    }
  }, /*#__PURE__*/React.createElement("div", {
    ref: chartTitleRef,
    style: {
      color: '#96AEB0',
      fontSize: 12,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      marginBottom: 10,
      paddingLeft: 8
    }
  }, t('portfolioValue', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 10,
      right: 10,
      zIndex: 15
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setRangePickerOpen(v => !v),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 3,
      background: '#0E2426',
      color: '#A0BABC',
      border: '1px solid #1A3436',
      borderRadius: 6,
      padding: '3px 8px',
      fontSize: 10.5,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif"
    }
  }, rangeLabel(range, lang), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 8,
      color: '#6C8688'
    }
  }, "▾")), rangePickerOpen && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: '100%',
      right: 0,
      marginTop: 4,
      zIndex: 20,
      background: '#0D2022',
      border: '1px solid #1A3436',
      borderRadius: 8,
      padding: 4,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
      minWidth: 70,
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
    }
  }, RANGES.map(r => /*#__PURE__*/React.createElement("button", {
    key: r.days,
    onClick: () => {
      setRange(r.days);
      setRangePickerOpen(false);
    },
    style: {
      background: range === r.days ? 'rgba(0,222,225,0.14)' : 'transparent',
      color: range === r.days ? '#00DEE1' : '#A0BABC',
      border: 'none',
      borderRadius: 5,
      padding: '5px 8px',
      fontSize: 11,
      fontWeight: 600,
      cursor: 'pointer',
      fontFamily: "'Inter', sans-serif",
      textAlign: 'left'
    }
  }, rangeLabel(r.days, lang))))), /*#__PURE__*/React.createElement("div", {
    key: `tp-${range}`,
    className: "tp-chart-fade-in"
  }, /*#__PURE__*/React.createElement(PortfolioChart, {
    data: filteredHistory,
    hideValues: hideValue,
    lang: lang,
    currency: currency,
    storageKeyPrefix: `tp-${range}`,
    // Höhe wird zur Laufzeit am 24h-Volumen-Kärtchen ausgemessen (siehe matchedChartHeight
    // weiter oben). Solange noch nicht gemessen wurde (erster Frame, kein Volumen-Kärtchen
    // sichtbar, Mobilansicht), gilt der statische Standardwert.
    height: matchedChartHeight != null ? matchedChartHeight : typeof window !== 'undefined' && window.innerWidth < 640 ? 190 : 193,
    allowDrawing: false,
    restrictHoverToLine: true,
    showAxis: false,
    showAreaFill: true
  })))), (volume24h != null || bonded != null && bonded > 0 || altPrice != null || hasAnyNodeRewardsData) && /*#__PURE__*/React.createElement("div", {
    className: `tp-sidebar-col tp-details-panel ${mobileTab === 'details' ? 'tp-panel-active' : ''}`,
    style: {
      flex: '1 1 240px',
      maxWidth: 300,
      minWidth: 240,
      display: 'flex',
      flexDirection: 'column',
      gap: 20
    }
  }, priceRowBox && /*#__PURE__*/React.createElement("div", {
    className: "tp-price-sidebar"
  }, priceRowBox), nodeRewardsBox, volume24h != null && /*#__PURE__*/React.createElement("div", {
    ref: volCardRef,
    className: "tp-side-card",
    style: {
      ...cardShellStyle,
      padding: '18px 20px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginBottom: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#96AEB0',
      fontSize: 11.5,
      fontWeight: 600,
      letterSpacing: '0.04em',
      textTransform: 'uppercase'
    }
  }, t('volume24h', lang))), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#FFFFFF',
      fontFamily: "'Space Grotesk', sans-serif",
      fontWeight: 700,
      fontSize: 24,
      lineHeight: 1.2
    }
  }, fmtUSDCompact(volume24h * (activePrice || 0), lang, currency)), /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#5C7274',
      fontSize: 10.5,
      marginTop: 2
    }
  }, t('swapVolumeLabel', lang)), /*#__PURE__*/React.createElement(VolumeSparkline, {
    data: volumeHistory,
    activePrice: activePrice,
    lang: lang,
    currency: currency
  }))))), runePriceChartModal, compareChartModal, /*#__PURE__*/React.createElement("div", {
    className: "tp-footer",
    style: {
      marginTop: 40,
      paddingTop: 20,
      borderTop: '1px solid #102224',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("a", {
    href: "https://thordex.eth.limo/?ref=maxim",
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: '#0A0A0A',
      fontSize: 12.5,
      fontWeight: 700,
      textDecoration: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      background: 'linear-gradient(135deg, #00DEE1, #00A8B0)',
      padding: '9px 18px',
      borderRadius: 999,
      boxShadow: '0 0 0 rgba(0, 222, 225, 0)',
      transition: 'box-shadow 0.2s, transform 0.2s'
    },
    onMouseOver: e => {
      e.currentTarget.style.boxShadow = '0 0 18px rgba(0, 222, 225, 0.55)';
      e.currentTarget.style.transform = 'translateY(-1px)';
    },
    onMouseOut: e => {
      e.currentTarget.style.boxShadow = '0 0 0 rgba(0, 222, 225, 0)';
      e.currentTarget.style.transform = 'none';
    }
  }, /*#__PURE__*/React.createElement(IconSwapArrows, {
    size: 14
  }), t('swapHere', lang)), /*#__PURE__*/React.createElement("a", {
    href: "https://x.com/runemaxim?s=11",
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: '#FFFFFF',
      fontSize: 12.5,
      fontWeight: 700,
      textDecoration: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      background: '#102224',
      border: '1px solid #223638',
      padding: '9px 18px',
      borderRadius: 999,
      boxShadow: '0 0 0 rgba(255, 255, 255, 0)',
      transition: 'box-shadow 0.2s, border-color 0.2s, transform 0.2s'
    },
    onMouseOver: e => {
      e.currentTarget.style.boxShadow = '0 0 14px rgba(255, 255, 255, 0.25)';
      e.currentTarget.style.borderColor = '#5C7274';
      e.currentTarget.style.transform = 'translateY(-1px)';
    },
    onMouseOut: e => {
      e.currentTarget.style.boxShadow = '0 0 0 rgba(255, 255, 255, 0)';
      e.currentTarget.style.borderColor = '#223638';
      e.currentTarget.style.transform = 'none';
    }
  }, /*#__PURE__*/React.createElement(IconX, {
    size: 13
  }), "@runemaxim"), /*#__PURE__*/React.createElement("a", {
    href: "https://github.com/RUNEMaxim/rune.watch",
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      color: '#FFFFFF',
      fontSize: 12.5,
      fontWeight: 700,
      textDecoration: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      background: '#102224',
      border: '1px solid #223638',
      padding: '9px 18px',
      borderRadius: 999,
      boxShadow: '0 0 0 rgba(255, 255, 255, 0)',
      transition: 'box-shadow 0.2s, border-color 0.2s, transform 0.2s'
    },
    onMouseOver: e => {
      e.currentTarget.style.boxShadow = '0 0 14px rgba(255, 255, 255, 0.25)';
      e.currentTarget.style.borderColor = '#5C7274';
      e.currentTarget.style.transform = 'translateY(-1px)';
    },
    onMouseOut: e => {
      e.currentTarget.style.boxShadow = '0 0 0 rgba(255, 255, 255, 0)';
      e.currentTarget.style.borderColor = '#223638';
      e.currentTarget.style.transform = 'none';
    }
  }, /*#__PURE__*/React.createElement(IconGithub, {
    size: 13
  }), "Source code"), DONATION_ENABLED && /*#__PURE__*/React.createElement("button", {
    onClick: () => setDonationOpen(v => !v),
    title: t('donateHint', lang),
    style: {
      color: '#FFFFFF',
      fontSize: 12.5,
      fontWeight: 700,
      cursor: 'pointer',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 7,
      background: donationOpen ? '#16292B' : '#102224',
      border: `1px solid ${donationOpen ? '#5C7274' : '#223638'}`,
      padding: '9px 18px',
      borderRadius: 999,
      fontFamily: "'Inter', sans-serif",
      boxShadow: '0 0 0 rgba(255, 255, 255, 0)',
      transition: 'box-shadow 0.2s, border-color 0.2s, transform 0.2s'
    },
    onMouseOver: e => {
      e.currentTarget.style.boxShadow = '0 0 14px rgba(255, 255, 255, 0.25)';
      e.currentTarget.style.borderColor = '#5C7274';
      e.currentTarget.style.transform = 'translateY(-1px)';
    },
    onMouseOut: e => {
      e.currentTarget.style.boxShadow = '0 0 0 rgba(255, 255, 255, 0)';
      e.currentTarget.style.borderColor = donationOpen ? '#5C7274' : '#223638';
      e.currentTarget.style.transform = 'none';
    }
  }, /*#__PURE__*/React.createElement(IconWallet, {
    size: 13
  }), t('donate', lang))), DONATION_ENABLED && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateRows: donationOpen ? '1fr' : '0fr',
      transition: 'grid-template-rows 0.25s ease',
      maxWidth: 460,
      marginLeft: 'auto',
      marginRight: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      overflow: 'hidden',
      opacity: donationOpen ? 1 : 0,
      transition: 'opacity 0.2s ease'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 14,
      textAlign: 'left',
      background: 'linear-gradient(165deg, #0C1F21 0%, #0A0A0A 100%)',
      border: '1px solid #172E30',
      borderRadius: 14,
      padding: '14px 16px',
      boxShadow: '0 1px 0 rgba(255,255,255,0.04) inset, 0 14px 28px -18px rgba(0,0,0,0.7)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#7C9698',
      lineHeight: 1.55
    }
  }, t('donateText', lang)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      marginTop: 12
    }
  }, DONATION_ADDRESSES.map(d => {
    const copied = donationCopied === d.chain;
    const doCopy = () => {
      // Adresse in die Zwischenablage kopieren. navigator.clipboard gibt es nur in sicheren
      // Kontexten (HTTPS) -- deshalb ein Fallback über ein temporäres Textfeld, damit es auch
      // in älteren Browsern bzw. lokal per file:// funktioniert.
      const copy = async () => {
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(d.address);
          } else {
            const ta = document.createElement('textarea');
            ta.value = d.address;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          }
          setDonationCopied(d.chain);
          setTimeout(() => setDonationCopied(null), 2000);
        } catch (e) {/* Kopieren fehlgeschlagen -- Adresse steht trotzdem zum Abtippen da */}
      };
      copy();
    };

    // Aufgebaut über benannte Zwischenvariablen statt einem tief verschachtelten
    // React.createElement(...)-Einzeiler -- bei mehreren Ebenen ineinander verschachtelter
    // Aufrufe verzählt man sich beim manuellen Zählen der schließenden Klammern leicht (genau
    // das ist beim ersten Versuch dieser Zeile auch passiert). So bleibt jeder Aufruf für sich
    // kurz und die Struktur unmittelbar nachvollziehbar.
    const chainLabel = /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: '#00DEE1',
        marginBottom: 2
      }
    }, d.chain);

    const addressLine = /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10.5,
        color: '#B7C7C8',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      },
      title: d.address
    }, d.address);

    // Klarstellung, dass es eine Chain-Adresse ist (kein einzelnes Token) -- eine Ethereum-
    // Adresse nimmt z.B. auch USDC/USDT/andere ERC-20s an, nicht nur ETH, und umgekehrt bei
    // THORChain. Nur mit "RUNE" bzw. "ETH" zu beschriften wäre irreführend gewesen.
    const assetsHint = /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 9.5,
        color: '#5C7274',
        marginTop: 3
      }
    }, t(d.assetsHintKey, lang));

    const infoColumn = /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        flex: 1
      }
    }, chainLabel, addressLine, assetsHint);

    const copyIcon = copied ? /*#__PURE__*/React.createElement(IconCheck, {
      size: 12
    }) : /*#__PURE__*/React.createElement(IconCopy, {
      size: 12
    });

    const copyButton = /*#__PURE__*/React.createElement("button", {
      onClick: doCopy,
      title: t('donateCopyHint', lang),
      style: {
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        background: copied ? 'rgba(111,191,143,0.16)' : 'rgba(0,222,225,0.1)',
        border: `1px solid ${copied ? 'rgba(111,191,143,0.45)' : 'rgba(0,222,225,0.35)'}`,
        borderRadius: 7,
        padding: '6px 10px',
        color: copied ? '#6FBF8F' : '#00DEE1',
        fontSize: 10.5,
        fontWeight: 600,
        fontFamily: "'Inter', sans-serif",
        cursor: 'pointer',
        transition: 'background 0.15s, border-color 0.15s, color 0.15s'
      }
    }, copyIcon, copied ? t('donateCopied', lang) : t('donateCopyAction', lang));

    return /*#__PURE__*/React.createElement("div", {
      key: d.chain,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: '#0E2426',
        border: `1px solid ${copied ? 'rgba(111,191,143,0.45)' : '#1A3436'}`,
        borderRadius: 9,
        padding: '8px 8px 8px 12px',
        transition: 'border-color 0.2s'
      }
    }, infoColumn, copyButton);
  }))))))));
}

// Letztes Sicherheitsnetz: fängt jeden unerwarteten Fehler beim Rendern ab (z.B. eine
// Datenform, die trotz aller try/catch-Blöcke oben nicht bedacht wurde) und zeigt statt eines
// weißen/leeren Bildschirms eine freundliche Meldung mit Neustart-Button. Lokal gespeicherte
// Wallet-Adressen/Einstellungen (localStorage) bleiben davon unberührt -- ein Reload reicht,
// es muss nichts neu eingegeben werden.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false
    };
  }
  static getDerivedStateFromError() {
    return {
      hasError: true
    };
  }
  componentDidCatch(error, info) {
    console.error('[RUNE Portfolio] Unerwarteter Fehler abgefangen:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return /*#__PURE__*/React.createElement("div", {
        style: {
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 24,
          textAlign: 'center',
          background: '#0A0A0A',
          color: '#F5F5F5',
          fontFamily: "'Inter', sans-serif"
        }
      }, /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 15,
          fontWeight: 600
        }
      }, "Something went wrong."), /*#__PURE__*/React.createElement("div", {
        style: {
          fontSize: 13,
          color: '#7C9698',
          maxWidth: 380
        }
      }, "Your saved wallets and settings are safe. Please reload the page."), /*#__PURE__*/React.createElement("button", {
        onClick: () => window.location.reload(),
        style: {
          background: 'linear-gradient(135deg, #00DEE1, #00A8B0)',
          color: '#0A0A0A',
          border: 'none',
          borderRadius: 999,
          padding: '10px 22px',
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: "'Inter', sans-serif"
        }
      }, "Reload"));
    }
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(ErrorBoundary, null, /*#__PURE__*/React.createElement(ThorchainPortfolio, null)));
