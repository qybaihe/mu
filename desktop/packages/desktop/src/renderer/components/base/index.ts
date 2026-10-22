/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 基础组件库统一导出 / Base components unified exports
 *
 * 提供所有基础组件和类型的统一导出入口
 * Provides unified export entry for all base components and types
 */

// ==================== 组件导出 / Component Exports ====================

export { default as MuModal } from './MuModal';
export { default as MuCollapse } from './MuCollapse';
export { default as MuSelect } from './MuSelect';
export { default as MuScrollArea } from './MuScrollArea';
export { default as MuSteps } from './MuSteps';
export { default as MuSearchInput } from './MuSearchInput';
export { default as MuInlineSearchInput } from './MuInlineSearchInput';

// ==================== 类型导出 / Type Exports ====================

// MuModal 类型 / MuModal types
export type { ModalSize, ModalHeaderConfig, ModalFooterConfig, ModalContentStyleConfig, MuModalProps } from './MuModal';
export { MODAL_SIZES } from './MuModal';

// MuCollapse 类型 / MuCollapse types
export type { MuCollapseProps, MuCollapseItemProps } from './MuCollapse';

// MuSelect 类型 / MuSelect types
export type { MuSelectProps } from './MuSelect';

// MuSteps 类型 / MuSteps types
export type { MuStepsProps } from './MuSteps';

// MuSearchInput 类型 / MuSearchInput types
export type { MuSearchInputProps } from './MuSearchInput';

// MuInlineSearchInput 类型 / MuInlineSearchInput types
export type { MuInlineSearchInputProps } from './MuInlineSearchInput';
