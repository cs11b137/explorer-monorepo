// 在首次绘制之前决定主题：优先用上次的选择，否则跟随系统。
try {
  var saved = localStorage.getItem('codegen-explorer:theme');
  var dark = saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
