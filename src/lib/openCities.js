// 内测开放生成范围：江浙沪（上海 + 江苏 13 市 + 浙江 11 市）。
export const JZH_CITIES = [
  '上海',
  '南京',
  '无锡',
  '徐州',
  '常州',
  '苏州',
  '南通',
  '连云港',
  '淮安',
  '盐城',
  '扬州',
  '镇江',
  '泰州',
  '宿迁',
  '杭州',
  '宁波',
  '温州',
  '嘉兴',
  '湖州',
  '绍兴',
  '金华',
  '衢州',
  '舟山',
  '台州',
  '丽水'
];

export function normalizeOpenCityLabel(value) {
  return String(value ?? '')
    .trim()
    .replace(/市$/u, '');
}

/** @param {string} city */
export function isJzhCity(city) {
  return JZH_CITIES.includes(normalizeOpenCityLabel(city));
}
