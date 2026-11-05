import { defineConfig } from 'vite';

// site/ 是线上构建产物的逐字节镜像，这里只把它当静态目录来预览，没有构建步骤。
export default defineConfig({ build: { outDir: 'site' } });
