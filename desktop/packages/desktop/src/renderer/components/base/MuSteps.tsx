/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Steps } from '@arco-design/web-react';
import type { StepsProps } from '@arco-design/web-react/es/Steps';
import classNames from 'classnames';
import React from 'react';

/**
 * 步骤条组件属性 / Steps component props
 */
export interface MuStepsProps extends StepsProps {
  /** 额外的类名 / Additional class name */
  className?: string;
}

/**
 * 步骤条组件 / Steps component
 *
 * 基于 Arco Design Steps 的封装，提供统一的样式主题
 * Wrapper around Arco Design Steps with unified theme styling
 *
 * @features
 * - 自定义品牌色主题 / Custom brand color theme
 * - 完成态的特殊样式处理 / Special styling for finished state
 * - 完整的 Arco Steps API 支持 / Full Arco Steps API support
 *
 * @example
 * ```tsx
 * // 基本用法 / Basic usage
 * <MuSteps current={1}>
 *   <MuSteps.Step title="步骤1" description="这是描述" />
 *   <MuSteps.Step title="步骤2" description="这是描述" />
 *   <MuSteps.Step title="步骤3" description="这是描述" />
 * </MuSteps>
 *
 * // 垂直步骤条 / Vertical steps
 * <MuSteps current={1} direction="vertical">
 *   <MuSteps.Step title="步骤1" description="描述" />
 *   <MuSteps.Step title="步骤2" description="描述" />
 * </MuSteps>
 *
 * // 带图标的步骤条 / Steps with icons
 * <MuSteps current={1}>
 *   <MuSteps.Step title="完成" icon={<IconCheck />} />
 *   <MuSteps.Step title="进行中" icon={<IconLoading />} />
 *   <MuSteps.Step title="待处理" icon={<IconClock />} />
 * </MuSteps>
 *
 * // 迷你版步骤条 / Mini steps
 * <MuSteps current={1} size="small" type="dot">
 *   <MuSteps.Step title="步骤1" />
 *   <MuSteps.Step title="步骤2" />
 *   <MuSteps.Step title="步骤3" />
 * </MuSteps>
 * ```
 *
 * @see arco-override.css for custom styles (.mu-steps)
 */
const MuSteps: React.FC<MuStepsProps> & { Step: typeof Steps.Step } = ({ className, ...props }) => {
  return <Steps {...props} className={classNames('mu-steps', className)} />;
};

MuSteps.displayName = 'MuSteps';

// 导出子组件 / Export sub-component
MuSteps.Step = Steps.Step;

export default MuSteps;
