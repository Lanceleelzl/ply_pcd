# 数据格式兼容与上传契约

## 1. 范围与统一原则

本项目把每个模型 A／B 视为一个独立数据集。数据集经过一次格式探测与完整性校验后，产生两个相互独立的通道：

```text
上传文件或数据集
├── 计算通道：解析／解码 XYZ → 确定性局部原点与采样 → 粗配准／ICP
└── 显示通道：轻量中心点预览，或用户切换时加载 Gaussian／LOD
```

ICP 始终以计算通道生成的 XYZ 点云为依据。Gaussian 属性、相机、显示 LOD、显示剖切、模型显隐和浏览器当前已加载块不得影响计算输入或最终矩阵。

## 2. 上传入口

支持三种上传形态：

1. 单文件：PLY、PCD、LAS、LAZ、bundled SOG。
2. 完整目录：unbundled SOG、Streamed SOG、LCC、LCC2。
3. ZIP 数据包：上述完整目录的 ZIP 表示，可直接包含入口，也可仅多一层共同根目录。

一个上传操作只能包含一个场景入口。目录和 ZIP 必须保留原始相对路径。首版拒绝 RAR、7z、分卷压缩、加密 ZIP、绝对路径、父目录路径、符号链接和远程 URL。

Web 首页为模型 A／B 分别提供“选择文件／ZIP”和“选择数据集目录”两个入口。目录上传通过 multipart 的 `model_a_files`／`model_b_files` 重复字段传输，每个 part 的 filename 必须是从所选根目录开始的相对路径；单文件仍使用 `model_a`／`model_b`。每个模型必须二选一，不能同时提交单文件和目录。服务端将目录按原路径封装为内部 ZIP 后复用同一探测、归档和恢复链路，不接受只有浏览器本地绝对路径的清单。

当前硬限制为每个数据集最多 `100000` 个文件、解包后最多 `100 GiB`、ZIP 总压缩比最多 `200:1`。这是安全上限，不是已验证的推荐上传规模；生产展示值仍需根据反向代理、磁盘、内存和网络压测结果收紧。

## 3. 单文件格式

| 格式 | 入口 | 计算要求 | Gaussian 显示 |
|---|---|---|---|
| 普通 PLY | `*.ply` | `vertex` 必须包含有限的 `x/y/z` | 不可用 |
| Gaussian PLY | `*.ply` | ICP 只读取 `x/y/z` | 尺度、旋转、不透明度及基础颜色完整时可用；SH 可选 |
| PlayCanvas compressed PLY | `*.compressed.ply` 或内容匹配的 `*.ply` | 解码打包位置为 XYZ | 可用 |
| PCD | `*.pcd` | 按现有受支持编码解析 XYZ | 不可用 |
| LAS／LAZ | `*.las`、`*.laz` | 先以 float64 应用文件头 scale／offset，再生成局部 XYZ | 不可用 |
| bundled SOG | `*.sog` | 从 SOG 位置数据解码 XYZ | 可用 |

格式必须按内容探测，扩展名仅用于候选筛选。普通二进制 PLY、compressed PLY 和 ZIP 压缩包是不同概念。

Gaussian PLY 首版基线属性为 `x/y/z`、`scale_0..2`、`rot_0..3`、`opacity`、`f_dc_0..2` 和可选 `f_rest_*`。用于高斯转换和显示的首版基线为 `binary_little_endian`；ASCII Gaussian PLY 只保证按 XYZ 点云进入计算。XYZ 完整但 Gaussian 属性不足时，数据集仍可计算和显示中心点，高斯显示标记为不可用。

## 4. 多文件 SOG

入口固定为 `meta.json`，其同级或下级必须包含元数据引用的所有图像：

```text
scene/
├── meta.json
├── means_l.webp
├── means_u.webp
├── scales.webp
├── quats.webp
├── sh0.webp
├── shN_centroids.webp   # 元数据声明高阶 SH 时必需
└── shN_labels.webp      # 元数据声明高阶 SH 时必需
```

文件名以 `meta.json` 中的引用为准。系统校验元数据版本、数量、图像尺寸、引用边界和资源完整性。首版目标基线为 SOG version 2。

## 5. Streamed SOG

首版目标基线为 Streamed SOG version 1。上传目录或 ZIP 必须包含唯一的 `lod-meta.json`：

```text
scene/
├── lod-meta.json
├── 0_0/
│   ├── meta.json
│   └── *.webp
├── 0_1/
│   ├── meta.json
│   └── *.webp
├── 1_0/
│   ├── meta.json
│   └── *.webp
└── env/                 # 可选
    ├── meta.json
    └── *.webp
```

目录名不是识别依据。加载器必须使用 `lod-meta.json.filenames` 解析每个块的 `meta.json`。每个块是 unbundled SOG，不接受用 bundled `.sog` 替换。

校验要求：

- `lodLevels`、`counts`、`count` 一致，版本大于 1 时拒绝。
- 空间树内部节点必须有两个子节点；叶节点使用 `lods`，两者不能并存。
- `file` 必须在 `filenames` 范围内，`offset/count` 必须落在对应 SOG 块内。
- 同一块的引用区间不得重叠，并应覆盖块内有效 Gaussian。
- 每个叶节点的 LOD 0 是最高精细表示；同一区域计算时只选择一个层级。
- `environment` 若存在则必须完整；环境 Gaussian 默认仅显示，不参与 ICP。

计算通道固定遍历所有叶节点的 LOD 0，按叶节点和区间顺序提取不重复 XYZ，再进入现有确定性采样。浏览器根据相机选择的层级只服务显示。

没有受支持索引清单的 `lod0.ply/lod1.ply` 或 `tile_*.ply` 散装文件不作为 LOD 数据集接收。

## 6. LCC

完整数据集结构：

```text
scene/
├── scene.lcc            # 必需，恰好一个入口，名称不限
├── Index.bin            # 必需
├── Data.bin             # 必需
├── Shcoef.bin           # Quality 模式必需
├── Environment.bin      # 可选，仅显示
└── Collision.lci        # 可选，本项目不使用
```

“LCC1”指第一代 LCC 数据组织，不表示元数据版本必须为 1。版本采用实测白名单；未知版本拒绝解析。Portable 模式允许没有 `Shcoef.bin`；Quality 模式声明高阶 SH 时必须提供该文件。

首版接收 `fileType=Portable` 或 `fileType=Quality`；缺失或未知模式拒绝。Quality 必须包含 `Shcoef.bin`。

计算通道依据 `Index.bin` 的 LOD 0 记录从 `Data.bin` 解码 XYZ，不读取 SH、环境或碰撞数据进入 ICP。

显示通道在服务端转换为 Streamed SOG 资源树并保留原有 LOD，再由浏览器按相机加载；不会把供 ICP 使用的完整 LOD 0 PLY 当作 LOD 显示源。显示转换失败时只返回 `gaussian_status=failed`，已经成功生成的 XYZ 仍可预览和配准。

## 7. LCC2

完整数据集结构：

```text
scene/
├── scene.lcc2           # 必需，恰好一个入口
└── data/
    ├── 3dgs/            # 必需，包含入口引用的全部高斯块
    └── mesh/            # 可选，本项目不使用
```

首版目标基线为公开数据组织版本 0.0.3。入口引用的 PLY、SPZ、SOG 等块必须全部包含；块本身是多文件格式时，其递归依赖也必须完整。支持 LCC2 需要同时支持该数据集实际使用的块编码，未支持的块编码应明确拒绝。

入口还必须提供正整数 `totalLevels`、非负整数 `totalSplats`，并使 `lodSplats` 长度与 `totalLevels` 一致。首版块编码白名单为 `.ply`、`.spz`、`.sog`，其他 `splatType` 明确拒绝。

计算通道遍历完整 LOD 0 叶节点，只解码每块位置并去除清单定义的重复表示。网格、BVH、环境和显示提示不进入 ICP。

显示通道同样转换为 Streamed SOG 资源树；转换失败与计算通道状态分开记录。

## 8. 处理状态与错误边界

服务分别返回 `xyz_status` 和 `gaussian_status`：

- XYZ ready：允许中心点预览、粗配准和 ICP。
- Gaussian ready：允许切换 Gaussian；LOD 数据允许流式显示。
- Gaussian failed：保留 XYZ 能力，不阻断配准。
- XYZ failed：禁止配准，即使某个原生查看器能够显示文件。

导入摘要至少返回识别格式、版本、入口、资源完整性、源点数、计算点数、计算 LOD、局部原点、包围盒、高斯显示能力、流式显示能力及不可用原因。

## 9. 资源和安全限制

上传总大小、解压后总大小、文件数、单文件大小、点数、处理内存、显示缓存和并发上限必须由目标服务器压测后配置，并在上传前展示。ZIP 校验必须防止路径越界和解压炸弹；所有格式引用只能解析到当前数据集根目录内。

## 10. 验收基线

每种格式必须使用最小合成样本和真实导出样本验证：格式识别、资源缺失、点数、包围盒、局部原点、XYZ 一致性、参考查看器画面、混合格式配准及错误恢复。相同计算数据和参数下，点云／Gaussian 切换、相机变化、显示 LOD 和剖切变化不得改变 ICP 输入摘要、RMS 或矩阵。
