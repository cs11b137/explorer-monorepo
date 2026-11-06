# DB Explorer

用交互动画讲解数据库系统原理：看懂一条 SQL 如何被执行和保存。15 节课涵盖解析、代价估算、索引扫描、哈希连接、外部排序、页与元组布局、缓冲区、B+ 树、LSM 树、VACUUM、MVCC、隔离级别、锁、WAL 和崩溃恢复。

课程内容以 PostgreSQL 17（x86-64 小端，8 KiB 页）为基准，并对照 REL_17_STABLE 源码核实。每节课都讲清楚哪些是通用原理，哪些是 PostgreSQL 的具体做法。

版式和交互参考了 [Dilum Sanjaya](https://x.com/DilumSanjaya) 的 [Protocol Explorer](https://protocol-explorer-alpha.vercel.app/)。代码和图形是独立编写的。

## 开发

本模块由主站统一提供服务，地址是 `/modules/db/`。启动和构建都在仓库根目录运行，见根目录的 README。下面的命令在本目录运行：

```sh
npm test           # 本模块的单元测试
```

## 结构

- `src/engine/`：真实的算法实现，不依赖界面：页面布局写入器、HOT 更新和清理、时钟扫描、B+ 树插入与分裂、MVCC 可见性判断、外部归并、哈希连接、代价公式、死锁检测、SSI、WAL 编码与重放、CRC-32C，以及 LevelDB 的日志、MemTable、SSTable、布隆过滤器、读路径和合并（`lsm.ts`）。
- `src/lessons/`：每节课一个文件。课程调用引擎，把真实结果变成事件。
- `src/decode/`：按真实布局解码字节的字段写入器和各结构定义。
- `src/scene/`：等距场景、设备图形和结构板（`boards.ts`：页面带、缓冲帧、树、快照数轴、哈希桶、等待图、WAL 带）。
- 时钟、播放器、场景、界面和基础样式都在 `packages/engine`，本模块的配置在 `src/site.ts`。
- `tests/golden/`：从真实 PostgreSQL 17 抓取的数据：`get_raw_page` 的堆页和索引页、`pg_wal` 里的记录、前后端协议抓包；`leveldb.json` 是 LevelDB 1.23 写出的 .log 和 .ldb 文件。

## 数据从哪里来

- 引擎产生的页面、索引和 WAL 记录与真实 PostgreSQL 17.11 逐字节比对（`tests/engine.test.ts`）。
- LSM 课的日志和表文件与 LevelDB 1.23 写出的文件逐字节比对，哈希用 LevelDB 自带的测试向量核对。MemTable 放 4 条就满、L0 有 2 个文件就合并，这两个阈值是为了演示调小的，界面上标明了。
- 代价公式的结果和 `EXPLAIN` 比对，哈希值和 `hashint4` 比对，外部排序的磁带数和 `trace_sort` 日志比对。
- B+ 树的课程把页缩小到 128 字节，这样一屏能看到分裂；算法和布局与 8 KiB 页是同一份代码，界面上标明了这一点。
- 轨迹表的时间是量级示例，标 E.G.。事务号、LSN、OID 也是示例值。

## 增加一节课

在 `src/lessons/` 新建文件并加入 `src/lessons/index.ts`。`tests/lessons.test.ts` 会自动检查节点显示顺序、时间单调、字段范围、结构板是否越界，以及通道是否穿过其他设备。
