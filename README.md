# SeqTK English README

>[!CAUTION] 
>The interface language of this plugin is Chinese. There are plans for multi-language adaptation, but it has not been implemented yet.

An Obsidian project management plugin designed for long-term and complex tasks. **
Write "one thing" as an independent node document, organize and connect different nodes through subordination, status and basis to form a combined project, and then let the process and script push the next task to be done to you according to the rules you set without immediate decision-making.

This is suitable for the needs of "long-term, multi-parallel projects": papers, long-term development, event planning, research tracking, and decision-making processes that require traceability.

> Current version 0.1.4 · Requires Obsidian 1.13.0 or higher · Available on desktop and mobile

- The development of this plugin was initially to meet my personal needs, so I will carry out long-term updates and maintenance on it
- This plugin has been completely restructured. Currently, only **transaction design** has been confirmed as fully usable. The remaining available views are available for development and will continue to be migrated and developed later.

---

## What Problems Does It Solve

Other personal task management tools often struggle to maintain long-term tasks:

1. **Disorganized Structure** - There is no clear project hierarchy or lifecycle, and they are managed mainly by tasks and lists as the levels.
2. **Difficult Organization** - It is difficult to perform batch editing or writing using text. One must rely on the inconvenient visualization tools provided by the software.
3. **Information Separation** - Information and task items are scattered across different software or different descriptions of task items. It is difficult to review and organize long descriptions or complex, structured descriptions.
4. **Lack of Design** - Information cannot be embedded at the same level as the tasks, meaning it is impossible to leave traces for thinking during the design process.
5. **Rule Pushing** - There is no system to recommend tasks based on rules. The list always shows the complete list of tasks to be completed, and you always have to make an immediate decision on what to do next, which is very exhausting when the task volume is large.

What needs to be done here is to ensure visualization while increasing the freedom of personal long-term task management.

SeqTK's approach is to place these three things in their respective positions and completely manage the information in the form of node files:
**Structure** is assigned to the hierarchy of frameworks and transactions,
**Status** is assigned to the propagable node attributes,
**Based on** is assigned to the nodes attached to the nodes.
All three are within the same node system and can be referenced, re-arranged as a whole, and batch rewritten.

---

## Design Orientation

- **Nodes are Documents.** Each node represents a Markdown document in the repository. You can leave the plugin at any time and read, search, synchronize, and perform version control using the native methods of Obsidian - the plugin is not the gatekeeper of the data.
- **Relationships are Written in the Document.** Dependencies, sequence, status, evidence are all recorded within the node document itself. The plugin maintains only a **query cache that can be rebuilt at any time**.
- **Design Comes Before Execution.** First, use "transaction design" to clearly think through the structure and basis, then hand it over to time and scripts using "draft → design → push" process. The design phase does not promise a specific time, and the execution phase does not repeat the design.
- **Only Touch the Directories It Manages.** The plugin only reads and writes nodes within its own data root directory; your other notes are not affected. Uninstalling the plugin will not lose any nodes.
- **It Does Not Make Decisions for You.** It does not enforce workflows, does not send reminders, and does not use cloud services; destructive operations (archiving, deletion) are executed according to the confirmation level you have configured.

---

## Core Concepts

### Nodes and Categories

Nodes are classified into five categories based on their functions, and each category further includes specific types (these specific types are what you are given when creating a node):

| Category | Specific Type | Purpose |
| --- | --- | --- |
| Framework | Transaction framework, Information framework, Template framework | The framework for holding things: an entire project, a data area, a set of reusable structures |
| Transaction | Concept, Project, Direction, Goal, Process, List, Item, Event | The thing you want to advance, from idea all the way down to executable actions |
| Evidence | Object, Condition, Information, State | The basis for judging a transaction: the involved object, preconditions, data clues, snapshot state |
| Operation | Edit log, Behavior log, Process status | Automatic recording: what changes occurred when, where the process reached |
| Script | Process script, Execution script, Query script | Write rules as executable things, let the process advance automatically according to time or events |

### Hierarchy and Dependency

There are clear dependencies and sequences between nodes, so "which stage an event belongs to and where it ranks" is part of the structure itself and does not need to be hinted at through labels or naming conventions:

- Frameworks can be nested to form a hierarchy such as "big project → sub-project → specific direction";
- Transactions are decomposed layer by layer along the chain (concept → direction → goal → process; list → item), each layer only accommodating the type it should, and moving to the wrong position will be blocked;
- There is a sequence between peers, and dragging directly can re-arrange; dragging will automatically maintain the order and the records of dependency on both sides, and there will be no "it seems moved but actually didn't change" misalignment.

### Status

Transaction nodes have statuses: **planning / in progress / completed / abandoned**. There are also **normal / suspended / blocked** as additional statuses to express "in progress but temporarily unable to move forward".

Status can be propagated between parent and child nodes according to the rules you configure: when the parent node enters a certain state, it changes the child nodes accordingly, or when all descendants meet the requirements, the result is aggregated upwards. Rules are configured in the settings, and you can also leave them unconfigured. This is the solution for the "invisible status" side - **progress grows automatically from the structure, without the need to maintain a separate progress table manually**.

### Evidence

Evidence is an independent node attached to transaction nodes (object, condition, information, state), not a paragraph of text in the main body. The advantage is that it can be retrieved separately, can be reused by multiple transactions, can be connected across transactions, and can be viewed as a network of relationships in the "Evidence Overview". External materials (web links, library files, timestamp documents) are hung on nodes separately, and do not interfere with the internal relationships.

### Templates, Archiving, and Recycling

- **Templates**: Any subtree can be "saved as a template", and then applied to other frameworks; template libraries are uniformly managed in the "Template Mode".
- **Archiving**: Things that are no longer active but still want to keep can be archived, and they will no longer disturb you in the default view; the handling method for descendants can be configured during archiving.
- **Recycling**: Archived nodes are concentrated in the "Recycling Mode", where they can be restored or completely deleted (the confirmation level for deletion can be configured).

---

## Function Overview

All panels of the plugin are listed by chapters in the "Control Console", and they can also be opened directly using commands.

### Transaction Design

| Panel | Function | Status |
| --- | --- | --- |
| Transaction Design | Main Interface: The left column is the framework tree, and the right column shows the content of the selected framework. Creating nodes, changing states, dragging and reordering, renaming, and batch editing can all be done here; the left column can also be delegated to the sidebar for easy operation while writing notes | Available |
| Evidence Overview | Without focusing on a single transaction, browse the global evidence relationships like a whiteboard, and connect cross-transaction evidence and establish unpointed evidence | Available |
| Line Mode | Project Line Chart: View the implicit connections and composite progress between frameworks | Available |
| Template Mode | Template Library Management: Organize template units, edit placeholders, and apply templates to target frameworks | Available |

Several capabilities in the transaction design are worth mentioning separately:

- **Batch Text Editing** - Export an entire subtree or the entire content of a framework as indented text, make changes, and then rewrite. The rewrites align according to "same level and position", so inserting a line will only shift it without treating the following content as a new node, and the main text will not be lost.
- **Extracting Node Groups from Text** - Select a block of indented list in the editor, and it directly becomes a node group; the categories are inferred by hierarchy, saving a lot of manual creation.
- **Copying Subtrees** - Copy to the same format of indented text, and it can be re-imported by pasting elsewhere.
- **Delegating Framework Tree** - Delegate the left column framework tree to the sidebar (using the side bar of the central control panel or an independent view), and the expansion and selection of both sides remain synchronized.

### Rule Design

| Panel | Function | Status |
| --- | --- | --- |
| Draft Process | Draft Board: Multiple parallel event axes, quickly finalize "what to do when" using time blocks. Blocks can either be read-only linked to nodes or directly write text | Available |
| Process Design | Write push rules for periods, dates, and time points; built-in switchable visual process programs and process script programs | Available |
| Process Push | Display the pushed task sequence on the right sidebar according to the specified process script | Available |
| Execution Binding | Bind execution actions to time points, or automatically trigger upon completion of a certain event | Under planning |
| Execution Design | Visually write execution programs, providing trigger-based or manual-based automation | Under planning |
| Query Design | Use built-in scripts for complex queries and parse the output of the query results | Under planning |

The process draft does not have dedicated grammar or reminders; it only focuses on setting the time, and the actual advancement is handled by the scripts in the process design.

### General Nodes

| Panel | Function | State |
| --- | --- | --- |
| Console Panel | Entry directory for all panels, organized by chapters, adjustable for display and order | Available |
| Recycling Mode | Viewing archived nodes, restoring or completely deleting | Available |
| Log Reading | Reading and searching logs in a categorized manner | In progress |
| Intelligent Collaboration | Intelligent agent identity and workflow records: Work control, memory review, terminology management | In progress |

---

## Typical Usage

**Start with a draft.** Write down your thoughts in a bulleted list with indentation in your mind, select it, use the command or right-click menu to extract it into a node group, and then continue adjusting the structure in the transaction design: remove what should be removed, attach evidence where necessary, set the status as required.

**Shape as you go.** If the hierarchy is incorrect, drag it; if the name is wrong, use the "Rename" option in the row menu to modify it in place. If you need to change a lot at once, use "Batch Text Editing" to export the entire subtree and modify it before overwriting. The entire process can be done without leaving this two-column interface.

**Transform a mature structure into a template.** If a certain framework dissection method works well, save it as a template; for the next project, simply apply it and only need to modify the placeholder content.

**Let time take over.** After the structure is determined, use the process draft to create a parallel event axis and finalize the start and end times; then use the process design to write the push rules; during daily work, the process push in the sidebar will tell you what to do at this moment.

**Clean up the site.** Archive completed tasks, restore them in the recycle mode when needed; delete outdated ones completely.

---

## Data and Security

- **Your nodes are the Markdown documents in your library.** Uninstalling plugins, changing devices, or using Git for version control do not affect them.
- **Plugins only read and write within their own directories.** The default data root directory is `_Root/_Plugin/SeqTK`, and it can be changed to any location in the settings; plugins will not access notes outside this directory.
- **The only additional maintenance is a query cache, used to speed up retrieval and overview.** It can be discarded when necessary, and can be regenerated using the command "Rebuild Query Cache", without affecting the node documents themselves.
- **There are confirmation strategies for destructive operations.** Archiving and deletion can each be configured with a prompt level, and can also set what to do with descendants when dealing with parent nodes.
- **There are no external services.** No internet connection, no uploads, and no reliance on any accounts.

---

## Installation

1. Prepare three files: `main.js`, `manifest.json`, and `styles.css` (these are directly usable in the `output/` directory of the repository).
2. Place them in the `<your-library>/.obsidian/plugins/seqtk/` directory within your library.
3. Reload Obsidian and enable **SeqTK** in "Settings → Third-party Plugins".

Requirements: Obsidian 1.13.0 or higher. Both desktop and mobile versions are compatible; the plugin is a single `main.js` file and no additional runtime files need to be downloaded and run.

---

## Quick Start

1. Open "Settings → SeqTK" and change the **data root folder** to the desired location (default is `_Root/_Plugin/SeqTK`).
2. Open the **command panel** and go to the **control panel**. It will list all the panels.
3. Open **transaction design**: Right-click in the blank area on the left → New frame.
4. In the right column, continue to right-click to create transactions, attach evidence; drag and adjust the order and dependencies; switch the status with the status circle; and change the name and description in the row menu.
5. If you want to keep the framework tree in the sidebar permanently, enable **delegate** in the transaction design.
6. To reuse the structure, "Save as template". For batch processing, use "Batch text editing".

When you need to reuse the structure, use "Save as template". For batch processing, use "Batch text editing".

---

## Boundaries and Current State

- This is a specialized management tool designed for **long-term complex tasks**, not a general to-do list tool. Short tasks without hierarchy, evidence, or traceability are not suitable for it; instead, it becomes cumbersome.
- The panels of "Intelligent Collaboration", "Log Review", "Execution Binding", "Execution Design", and "Query Design" are still under planning and will be marked in the control panel.
- The draft of the process intentionally does not have exclusive grammar or reminder functions; reminders and automation belong to the "Execution" step and are still to be implemented.
- The project is continuously evolving, and the interface text and settings may be adjusted with each version.

---

## Delving into the Source Code

This README only covers usage and design orientation. To understand the layered structure, the boundaries of each layer's responsibilities, and development conventions, refer to `src/README.md` and the documentation for each layer; the slicing organization rules for the design view can be found in `src/P6_Views/Views.md`.

# SeqTK 中文 README

**为长期复杂任务而做的 Obsidian 项目管理插件。** 
把「一件事」写成独立节点文档，通过从属、状态和依据组织与串联不同节点，形成组合项目，再让流程与脚本按你定下的规则不需要即时决策的向你推送下一件要做的事。

适合那种「长期、多并行项目」的需求：论文、长线开发、活动筹备、研究跟踪、需要留痕的决策过程。

> 当前版本 0.1.4 · 需要 Obsidian 1.13.0 或更高 · 桌面与移动端均可用

- 这个插件的开发首先是为了满足我个人需求，因此，我会对其进行长期的更新与维护
- 这个插件经过完全重构，目前仅有 **事务设计** 被确认为完全可用，其余可用视图、待开发后续会进行继续迁移与开发

---

## 它解决什么问题

其他个人任务管理工具，长线任务通常会难以维护：

1. **结构散乱** —— 没有确切项目层次、生命周期，均以任务、清单为层级管理
2. **组织困难** —— 难以使用文本进行批量编辑或写入，必须依靠其提供的不便利的可视化工具
3. **信息分离** —— 信息和任务项分散在不同软件中，或分散在不同任务项的描述，对长描述、复杂带有结构的描述难以审阅和组织
4. **缺乏设计** —— 无法嵌入和任务同级的信息，这意味着无法针对设计过程留下思考痕迹
5. **规则推送** —— 没有一套根据规则将任务进行推荐的系统，清单上始终会显示完整的待完成项，你始终要对下一件使其想做什么做即时决策，这在任务体量大时很消耗心力

这里要做的，就是在确保可视化的基础上，提高个人长线任务管理的自由度

SeqTK 的做法是把这三件事各归其位，彻底以节点文件形式进行信息管理：
**结构**交给框架与事务的层级，
**状态**交给可传播的节点属性，
**依据**交给挂在节点上的节点。
三者都在同一套节点体系里，可以互相引用、整体重排、批量改写。

---

## 设计取向

- **节点即文档。** 每个节点就是库里的一篇 Markdown 文档。你随时可以离开插件，用 Obsidian 原生方式阅读、搜索、同步、做版本控制——插件不是数据的看门人。
- **关系写进文档，不另立私库。** 从属、顺序、状态、证据都记录在节点文档自身，插件另外维护的只是一份**可随时重建**的查询缓存。
- **设计先于执行。** 先用「事务设计」把结构和依据想清楚，再用「流程草稿 → 流程设计 → 流程推送」把它交给时间和脚本。设计阶段不承诺时间，执行阶段不重复设计。
- **只碰它管的目录。** 插件只在自己的数据根目录内读写节点；你其它笔记不受影响。卸载插件不会丢失任何节点。
- **不替你做决定。** 不强制工作流、不发提醒、不做云服务；破坏性操作（归档、删除）按你配置的确认级别执行。

---

## 核心概念

### 节点与分类

节点按用途分五类，每一类下面再分具体类型（新建时给你的就是这些具体类型）：

| 分类 | 具体类型 | 用途 |
| --- | --- | --- |
| 框架 | 事务框架、信息框架、模板框架 | 装东西的骨架：一整个项目、一块资料区、一套可复用结构 |
| 事务 | 构想、项目、方向、目标、工序、清单、事项、事件 | 你要推进的事本身，从想法一路拆到可执行动作 |
| 证据 | 对象、条件、信息、状态 | 支持某个事务判断的依据：涉及对象、前置条件、资料线索、快照状态 |
| 运行 | 编辑日志、行为日志、流程状态 | 自动留痕：什么时候发生了什么改动、流程跑到哪一步 |
| 脚本 | 流程脚本、执行脚本、查询脚本 | 把规则写成可执行的东西，让流程按时间或事件自动推进 |

### 层级与从属

节点之间有明确的从属与顺序，所以「一件事属于哪个阶段、排在第几位」是结构本身，不需要靠标签或命名约定去暗示：

- 框架可以套框架，形成「大项目 → 子项目 → 具体方向」这样的层级；
- 事务沿链条层层拆解（构想 → 方向 → 目标 → 工序；清单 → 事项），每一层只容纳它该容纳的类型，落错位置会被拦住；
- 同级之间有先后顺序，直接拖动即可重排；拖动会自动维护顺序与从属两边的记录，不会出现「看着移了、实际没变」的错位。

### 状态

事务类节点带状态：**规划 / 进行 / 完成 / 放弃**。另有**正常 / 搁置 / 阻塞**这组附加状态，用来表达「在做、但暂时推不动」。

状态可以按你配置的规则在父子之间传播：父节点进入某状态时把子节点一起改写，或子节点全部达标时向上聚合结果。规则在设置里配置，也可以完全不配。这就是「状态不可见」那一侧的解法——**进度从结构里自动长出来，不用手工维护一份进度表**。

### 证据

证据是挂在事务节点上的独立节点（对象、条件、信息、状态），不是正文里的一段文字。好处是它可以被单独检索、可以被多个事务复用、可以跨事务连接，也可以在「证据总览」里作为一张关系网整体浏览。外部材料（网页链接、库内文件、时间戳文档）作为「外部信息源」单独挂在节点上，与内部关系互不干扰。

### 模板、归档与回收

- **模板**：任何一棵子树都可以「存为模板」，之后套用到别的框架上；模板库在「模板模式」里统一管理。
- **归档**：不再活跃但还想留着的东西归档掉，默认视图里不再打扰你；归档时后代的处理方式可以配置。
- **回收**：归档节点集中在「回收模式」里，可以还原，也可以彻底删除（删除的确认级别可配置）。

---

## 功能一览

插件所有面板都在「中控台」里按章节列出，也可以直接用命令打开。

### 事务设计

| 面板 | 作用 | 状态 |
| --- | --- | --- |
| 事务设计 | 主界面：左栏是框架树，右栏是选中框架的内容。建节点、改状态、拖拽重排、重命名、批量编辑都在这里完成；左栏还能整体委托到侧栏，方便边写笔记边操作 | 可用 |
| 证据总览 | 不聚焦单个事务，像白板一样浏览全局证据关系，可以连接跨事务的证据、建立暂无指向的证据 | 可用 |
| 线路模式 | 项目线路图：看框架之间的隐性关联与复合进度 | 可用 |
| 模板模式 | 模板库管理：整理模板单元、编辑占位、把模板应用到目标框架 | 可用 |

事务设计里几个值得单独一提的能力：

- **以文本批量编辑** —— 把一整棵子树或一个框架的全部内容导出成缩进文本，改完再回写。回写按「同层同位置」对齐，所以插入一行只会顺移而不会把后面的内容当成新节点，正文不会丢。
- **从文本提取节点组** —— 在编辑器里选中一段缩进列表，直接变成节点组；类别按层级推断，省掉大量手工新建。
- **复制子树** —— 复制成同样格式的缩进文本，粘到别处就能再导入。
- **委托框架树** —— 把左栏框架树委托到侧栏（借用中控台侧栏，或独立视图），两侧的展开与选中保持同步。

### 规则设计

| 面板 | 作用 | 状态 |
| --- | --- | --- |
| 流程草稿 | 草稿板：多条并行事件轴，用时间块快速敲定「什么时候做什么」，块可以只读关联节点，也可以直接写文本 | 可用 |
| 流程设计 | 为时段、日期、时间点编写推送规则；内置可切换的可视化流程程序与流程脚本程序 | 可用 |
| 流程推送 | 按指定流程脚本，在右侧边栏展示被推送的任务序列 | 可用 |
| 执行绑定 | 把执行行为绑定到时间点，或绑定到某个事件完成后自动触发 | 规划中 |
| 执行设计 | 可视化编写执行程序，提供触发式或手动式的自动化 | 规划中 |
| 查询设计 | 用内置脚本做复杂查询并解析输出查询结果 | 规划中 |

流程草稿刻意不做专属语法、不涉及提醒：它只负责把时间敲定，真正的推进交给流程设计里的脚本。

### 节点通用

| 面板 | 作用 | 状态 |
| --- | --- | --- |
| 中控台 | 所有面板的入口目录，按章节组织，可调整显示与顺序 | 可用 |
| 回收模式 | 阅览归档节点，还原或彻底删除 | 可用 |
| 日志阅览 | 条目化地阅览与搜索日志 | 规划中 |
| 智能协作 | 智能体身份与工作流记录：工作控制、记忆审查、术语管理 | 规划中 |

---

## 典型用法

**从一段草稿开始。** 把脑子里的想法按缩进写成列表，选中它，用命令或右键菜单提取成节点组，然后在事务设计里继续调整结构：该拆的拆、该挂证据的挂证据、该定状态的定状态。

**边用边定型。** 层级不对就拖，名字不对就用行菜单的「重命名」原地改，一次要改很多就用「以文本批量编辑」把整棵子树导出来改完再回写。整个过程不离开这张双栏界面。

**把成熟结构变成模板。** 某套框架拆法好用，就存成模板；下个项目直接套用，只需要改占位内容。

**让时间接手。** 结构定下来之后，用流程草稿排出并行事件轴、敲定起止时间；再用流程设计写成推送规则；日常工作时侧栏的流程推送会告诉你此刻该做什么。

**收拾现场。** 做完的事归档，需要时在回收模式里还原；过时的彻底删除。

---

## 数据与安全

- **你的节点就是你库里的 Markdown 文档。** 卸载插件、换设备、用 Git 做版本控制都不影响它们。
- **插件只在自己管的目录内读写。** 数据根目录默认在 `_Root/_Plugin/SeqTK`，可以在设置里改成任意位置；插件不会碰这个目录之外的笔记。
- **额外维护的只有一份查询缓存，用于加速检索与总览。** 它必要时可以丢弃，用命令「重建查询缓存」重新生成，不会影响节点文档本身。
- **破坏性操作有确认策略。** 归档与删除各自可以配置提示级别，也可以设置处理父节点时后代怎么办。
- **没有外部服务。** 不联网、不上传、不依赖任何账号。

---

## 安装

1. 准备三个文件：`main.js`、`manifest.json`、`styles.css`（仓库的 `output/` 目录里就是可直接使用的这一套）。
2. 在你的库中把它们放进 `<你的库>/.obsidian/plugins/seqtk/` 目录。
3. 重载 Obsidian，在「设置 → 第三方插件」中启用 **SeqTK**。

要求：Obsidian 1.13.0 或更高。桌面端与移动端都可以用；插件是单个 `main.js`，不需要额外下载运行时文件。

---

## 快速上手

1. 打开「设置 → SeqTK」，把**数据根文件夹**改成你希望的位置（默认 `_Root/_Plugin/SeqTK`）。
2. 用命令面板打开**中控台**，它会列出全部面板。
3. 打开**事务设计**：左栏空白处右键 → 新建框架。
4. 在右栏里继续右键新建事务、挂证据；拖拽调整顺序与从属，状态圆点切换状态，行菜单里可以重命名与改描述。
5. 框架树想放到侧栏常驻，就在事务设计里开启**委托**。

需要复用结构时「存为模板」，需要批量整理时用「以文本批量编辑」。

---

## 边界与现状

- 这是一套特化的针对**面向长期复杂任务**设计管理工具，不是通用的待办清单工具。用不上层级、证据、留痕的短任务，用它反而繁琐。
- 「智能协作」「日志阅览」「执行绑定」「执行设计」「查询设计」几个面板还在规划中，中控台里会标出来。
- 流程草稿有意不做专属语法、不涉及提醒；提醒与自动化属于「执行」那一步，仍待落地。
- 项目在持续演进，界面文案与设置项可能随版本调整。

---

## 深入源码

本 README 只讲用法与设计取向。要了解分层结构、各层职责边界与开发约定，见 `src/README.md` 与各层说明文档；设计视图的切片组织规则见 `src/P6_Views/Views.md`。
