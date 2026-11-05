// 在首次绘制之前决定主题。首页没有切换按钮，跟随系统。
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
