# 调试器能力包（`pack:debugger`）

更新日期：2026-09-22。状态：已完成并测试；**本机真实 debugpy 1.6.7 跑通**。delve、lldb-dap 只有代码和协议层的测试。

## 1. 要解决什么

模型排查“为什么这个值不对”“为什么卡住”的常用办法是加 print、跑一遍、再删掉，一个问题要来回好几轮。调试器一次就能给出答案：停在哪一行、调用栈、每一层的局部变量，还能在那一刻对表达式求值。

它是能力包：装在 mu 里但默认不露。模型用 `find_capability` 自己要时才打开；`capability.disclosure` 打开（默认关闭）时，判定器看出任务需要调试器也会打开。

## 2. 给模型的四个工具

| 工具 | 作用 |
| --- | --- |
| `debug_start` | 在调试器里运行程序，直到停在断点、停在**没人捕获的异常**处，或者程序结束。返回停在哪、调用栈、最内层的局部变量、断点有没有设上、程序的输出 |
| `debug_step` | 停住时：`next`（跳过这一行）、`stepIn`、`stepOut`、`continue`（到下一个断点或结束）。还在跑时：`pause`（停下来看它卡在哪）、`wait`（再等一会儿） |
| `debug_inspect` | 停住时：在某一层栈帧里对表达式求值；按 `ref` 展开一个变量的成员；看另一层栈帧的局部变量 |
| `debug_stop` | 结束调试，返回程序最后的输出 |

- 一次只跑一个调试。再调 `debug_start` 会先结束前一个，并在结果里说明。
- 程序结束，调试也随之结束，适配器进程一起退出。会话结束（退出、重载、切换会话）时结束；mu 进程退出时整个进程树立刻结束。
- 断点可以带条件（`condition: "x == 2"`）。
- 到了 `debugWaitMs`（默认 30 秒）程序还没停也没结束，就告诉模型“还在跑”，由它决定 `pause` 或 `wait`。用户按 Esc 时立刻不再等。
- 变量值、程序输出都来自被调试的程序，结果里标为不可信数据。
- `debug_start` 和 `debug_inspect` 在硬约束把关的检查范围内：被调试的程序会做它自己做的事，表达式求值也可能调用任意函数。
- 权限模式里也一样：带表达式的 `debug_inspect` 和 `debug_start` 一样算“运行程序”（判定模式下由判定器判断，最小权限时问你，“这次对话都允许”按 `debug_inspect` 记）；只按 `ref` 展开变量、看另一层栈帧不问。允许了 `debug_start` 只是允许跑这个程序，不等于允许在它里面执行任意代码。

## 3. 适配器

| id | 调试什么 | 通信 | 需要什么 |
| --- | --- | --- | --- |
| `debugpy` | `.py`，也能跑模块（`launch: {"module": "pytest"}`，用来调试一个失败的测试） | stdio | `python3 -m pip install debugpy`（Windows 上是 `python`） |
| `delve` | `.go`（程序或包目录；`launch: {"mode": "test"}` 调试测试） | TCP，端口由 mu 分配 | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| `lldb-dap` | 编译好的程序（C、C++、Rust、Swift），也是其它结尾的兜底 | stdio | macOS 自带在命令行工具里（不在 PATH 上，mu 会去 `/Library/Developer/CommandLineTools/usr/bin`、Xcode、Homebrew 的 llvm 下面找）；Windows `winget install LLVM.LLVM`；Linux 装 LLVM 18 以上 |

- 按程序的结尾选适配器，也可以用 `adapter` 指定。
- **Python 虚拟环境**：工作目录下有 `.venv` 或 `venv` 时，程序用那里的解释器运行（这样才找得到项目装的包），找适配器也先看那里。
- 装了 debugpy 才算找到：只有 `python3` 不够，打开时会跑一次 `import debugpy` 来确认。
- 缺哪个就给出这个平台的安装命令；mu 从不自己安装。一个适配器都没装时，包保持关闭。
- `launch` 参数是一段 JSON 文本（不是对象），因为有的模型服务商的工具参数格式不接受任意键的对象。

### 自己加适配器

在 mu.json 的 `features.packs.debugAdapters` 里按 id 添加或修改：

```json
{
	"features": {
		"packs": {
			"debugAdapters": {
				"js-debug": {
					"command": "/path/to/js-debug-adapter",
					"args": ["{port}"],
					"transport": "tcp",
					"extensions": [".js", ".mjs", ".ts"],
					"launch": { "type": "pwa-node" }
				},
				"debugpy": { "launch": { "justMyCode": false } }
			}
		}
	}
}
```

用户自己的适配器排在内置的前面，结尾冲突时它优先。改了内置适配器的 `command`，就不再做 `import debugpy` 那样的探测，也不再去别处找。

## 4. 协议上的细节

- **启动顺序**：各家适配器回答 `launch` 的时机不同。debugpy 要等 `configurationDone` 之后才回答，lldb-dap 在 `initialized` 事件之前就回答。所以 mu 发出 `launch` 后不等回答，而是等 `initialized` 事件，在那时设断点和异常过滤，再发 `configurationDone`。（测试里把它改成“先等 `launch` 的回答”，debugpy 顺序的用例和真实 debugpy 用例都会卡住失败。）
- **异常处停下**：适配器声明了默认开启的异常过滤（debugpy 的 “uncaught”）就打开它，所以程序崩溃时停在出事的那一行，局部变量都在。支持 `exceptionInfo` 时再取异常的类型和消息，比如 `ZeroDivisionError: division by zero`。
- **反向请求**（`runInTerminal` 等）：mu 没有终端可借，回答“不支持”，适配器照常工作。
- 输出里的 `telemetry` 类别不给模型看。
- 进程：POSIX 上适配器放在自己的进程组里，结束时整组杀掉，被调试的程序一起结束；Windows 用 `taskkill /T /F`。

## 5. 设置（`features.packs.*`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `debugger` | `true` | 开关 |
| `debugAdapters` | `{}` | 见上 |
| `maxFrames` | 20 | 停下时显示几层调用栈 |
| `maxVariables` | 50 | 每个作用域、每次展开最多列几个变量 |
| `debugOutputChars` | 4000 | 一次结果最多带多少程序输出，超出时只留最后的部分 |
| `debugWaitMs` | 30000 | 等程序停下的最长时间 |

## 6. 验证情况

`test/dap.test.ts`，13 个用例：

- 适配器表：按 id、结尾、兜底选择；用户适配器优先；修改内置时探测与候选路径的取舍；`launch` 参数合并（`request`、`name` 不可改）；虚拟环境只对 Python 生效（POSIX 与 Windows 路径）。
- 协议层，用一个替身适配器（`test/fixtures/fake-dap-adapter.mjs`，模拟 debugpy 和 lldb-dap 两种启动顺序、TCP、条件断点、异常、死循环）：断点、局部变量、展开成员、在不同栈帧求值、单步、运行到结束；没设上的断点及原因；反向请求被拒后照常工作；遥测输出被滤掉；TCP 加“先回答 launch”的顺序；条件断点；未捕获异常处停下并给出类型和消息、继续后以退出码 1 结束；死循环报告“还在跑”、`pause` 后停在循环那一行；Esc（中止信号）立刻不再等；启动失败、适配器不是这个协议时给出原因。
- 通过 pi 的测试 harness 走完整的包：没披露时工具不存在；披露后四个工具走一遍；缺适配器时给出安装命令；会话结束时适配器进程确实退出（按进程号检查）。
- **真实 debugpy**（本机装了才跑）：在函数里停两次、在调用方栈帧里求值、调用方栈帧里没有的变量报错、停在未捕获的 `ZeroDivisionError` 那一行、拿到程序输出。

做过变异检查：去掉异常过滤，异常用例和真实 debugpy 用例失败；改成先等 `launch` 的回答，debugpy 顺序的用例全部失败。

未验证：真实的 delve、lldb-dap（本机没装 delve；lldb-dap 在，但编译 C 程序要先同意 Xcode 许可，没有去动系统设置）；Windows；真实模型用这四个工具的效果。
