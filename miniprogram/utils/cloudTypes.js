/** Port of shared/cloudTypes.ts (labels only; the UI never needs the aliases). */
const CLOUD_TYPE_LABELS = {
  baidu: '百度网盘',
  quark: '夸克网盘',
  aliyun: '阿里云盘',
  uc: 'UC网盘',
  mobile: '中国移动云盘',
  tianyi: '天翼云盘',
  115: '115网盘',
  123: '123云盘',
  jianguoyun: '坚果云',
  lanzou: '蓝奏云',
  xunlei: '迅雷云盘',
  magnet: '磁力链接',
  others: '其他',
};

const CLOUD_TYPE_SHORT_LABELS = {
  baidu: '百度',
  quark: '夸克',
  aliyun: '阿里云',
  uc: 'UC',
  mobile: '移动',
  tianyi: '天翼',
  115: '115',
  123: '123',
  jianguoyun: '坚果云',
  lanzou: '蓝奏',
  xunlei: '迅雷',
  magnet: '磁力',
  others: '其他',
};

function platformLabel(type) {
  return CLOUD_TYPE_LABELS[type] || CLOUD_TYPE_SHORT_LABELS[type] || type || '其他';
}

/**
 * Monochrome glyph stand-ins for the web card's SVG icons (lightning bolt for
 * magnet links, external arrow for others, cloud for drives).
 */
function platformIcon(type) {
  if (type === 'magnet') return '\u26A1';
  if (type === 'others') return '\u2197';
  return '\u2601\uFE0E';
}

module.exports = { CLOUD_TYPE_LABELS, CLOUD_TYPE_SHORT_LABELS, platformLabel, platformIcon };
