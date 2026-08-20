# 本地运行与原生 Worker 管理

## 1．支持范围

当前开箱即用的本地环境：

```text
Windows 10／11 x64
Node.js >= 20
pnpm >= 10
```

普通使用者不需要安装 Python、Visual Studio、CMake、CloudCompare、Qt 或 PCL。

Linux 服务器使用 Docker 部署。Linux／macOS 本地原生 Worker 尚未提供预编译版本。

## 2．一键安装和启动

```powershell
git clone <repository-url>
cd ply_pcd
pnpm install
pnpm run dev
```

打开：

```text
http://localhost:8765
```

`pnpm install` 自动执行：

1. 下载固定版本的官方 `uv` 发布包。
2. 校验发布方提供的 SHA-256。
3. 在 `.tools/python` 安装项目专用 Python 3.12。
4. 根据 `uv.lock` 在 `.venv` 同步全部 Python 依赖。
5. 校验预编译 Worker 的源码指纹和 SHA-256。
6. 将当前 Worker 放入 `runtime/local/bin`。

所有自动安装内容均位于项目目录，不修改系统 Python 和 PATH。

## 3．Visual Studio 与 Worker 选择

### 没有 Visual Studio 2022

自动使用：

```text
runtime-bin/win32-x64/registration_worker.exe
```

该文件使用静态 MSVC Runtime 构建，不要求额外安装 VC++ Redistributable。`manifest.json` 记录 Worker SHA-256 和对应源码指纹。

可强制验证预编译路径：

```powershell
$env:REGISTRATION_NATIVE_MODE="prebuilt"
pnpm run setup:local
Remove-Item Env:REGISTRATION_NATIVE_MODE
```

### 已安装 Visual Studio 2022

编译并自动替换仓库内预编译 Worker：

```powershell
pnpm run build:native
```

该命令会：

1. 使用 `windows-release` CMake Preset 编译。
2. 覆盖 `runtime-bin/win32-x64/registration_worker.exe`。
3. 更新 `manifest.json` 的 Worker SHA-256 和源码指纹。
4. 将新 Worker 复制到 `runtime/local/bin` 供服务立即使用。

如果修改了 C++／CCCoreLib／CMake 源码，`pnpm run dev` 检测到源码指纹变化后也会在 VS2022 可用时自动重新编译。

如果源码已经改变但没有编译器，服务会拒绝使用与源码不匹配的旧 Worker，不会静默运行过期算法。

## 4．命令

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装 Node 元数据，并自动执行本地环境准备 |
| `pnpm run setup:local` | 重新检查 Python、依赖和 Worker；不要使用 pnpm 自带的 `pnpm setup` 命令 |
| `pnpm run dev` | 准备环境并启动本地服务 |
| `pnpm run start` | 与 `pnpm run dev` 相同，适合脚本化启动 |
| `pnpm run build` | 编译并替换 Windows 原生 Worker |
| `pnpm run build:native` | 与 `pnpm run build` 相同，语义更明确 |
| `pnpm run test` | 有 VS 时运行 CTest；无 VS 时执行预编译 Worker 数据检查 |
| `pnpm run docker:build` | 构建 Linux Docker 镜像 |
| `pnpm run docker:up` | 后台启动 Docker 服务 |
| `pnpm run docker:down` | 停止并移除项目 Docker 容器和 Compose 网络，不删除镜像与任务数据 |
| `pnpm run docker:logs` | 查看 Docker API 日志 |

## 5．本地配置

本地监听端口在 `config/local.json` 中配置：

```json
{
  "port": 8765
}
```

修改并保存端口后，重新执行 `pnpm run dev` 即可生效。端口必须是 `1` 至 `65535` 之间的整数。

本地服务只监听 `127.0.0.1`。如需局域网或公网访问，应通过经过鉴权和 HTTPS 配置的反向代理部署，不应直接修改为全网监听。

## 6．锁定文件

```text
pnpm-lock.yaml：pnpm 项目锁定文件
uv.lock：Python 及全部传递依赖的版本、下载地址和哈希
runtime-bin/win32-x64/manifest.json：Worker 与 C++ 源码一致性清单
```

直接修改 `service/requirements.txt` 不会更新本地锁。Python 依赖变更应同步修改 `pyproject.toml` 并重新执行：

```powershell
.tools\uv\uv.exe lock
pnpm run setup:local
```

Docker 使用从同一份 `uv.lock` 导出的 `service/requirements.lock.txt`，并通过 `pip --require-hashes` 安装。直接依赖版本仍应与 `service/requirements.txt` 保持一致。

## 7．本地与 Docker 切换

本地和 Docker 默认都使用 `8765`，同一时间只能启动一个：

```powershell
pnpm run docker:down
pnpm run dev
```

或：

```powershell
# 先在 pnpm run dev 窗口按 Ctrl+C
pnpm run docker:up
```
