/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Select } from '@arco-design/web-react';
import type { SelectProps } from '@arco-design/web-react';
import type { SelectHandle } from '@arco-design/web-react/es/Select/interface';
import classNames from 'classnames';
import React, { useEffect, useImperativeHandle, useRef } from 'react';

/**
 * 自定义下拉选择组件属性 / Custom select component props
 */
type NativeSelectProps = Omit<SelectProps, 'size'>;
type NativeSelectSize = NonNullable<SelectProps['size']>;
type MuSelectSize = NativeSelectSize | 'middle';

export interface MuSelectProps extends NativeSelectProps {
  /** 额外的类名 / Additional class name */
  className?: string;
  /** 统一尺寸，新增 middle（32px）/ Unified size with additional "middle" (32px) */
  size?: MuSelectSize;
}

/**
 * 基础样式类名
 * Base classes. `mu-select` marks the component, for tests and custom CSS themes; its look is the utilities below.
 */
const BASE_CLASS = classNames(
  'mu-select',
  '[&_.arco-select-view]:rounded-[4px]',
  '[&_.arco-select-view]:border',
  '[&_.arco-select-view]:border-solid',
  '[&_.arco-select-view]:border-border-2',
  '[&_.arco-select-view]:shadow-none',
  '[&_.arco-select-view]:transition-colors',
  '[&_.arco-select-view:hover]:border-[var(--color-primary)]',
  '[&_.arco-select-view:focus-within]:border-[var(--color-primary)]',
  '[&_.arco-select-view-disabled]:bg-[var(--color-bg-2)]',
  '[&_.arco-select-view-disabled]:opacity-80'
);

/**
 * 默认的弹出层容器获取函数
 * 始终返回 document.body 以避免嵌套容器导致的 ResizeObserver 循环错误
 * Default popup container getter function
 * Always returns document.body to avoid ResizeObserver loop errors from nested containers
 */
const defaultGetPopupContainer = (): HTMLElement => {
  // 在浏览器环境下始终挂载到 body，避免嵌套容器导致 ResizeObserver 循环
  // Always mount popup to body in browsers to avoid nested-container ResizeObserver loops
  if (typeof document !== 'undefined' && document.body) {
    return document.body;
  }
  // SSR/测试环境降级返回占位，具体不会真正渲染
  // Fallback for SSR/tests – this code path shouldn't render popups
  return undefined as unknown as HTMLElement;
};

/**
 * 自定义下拉选择组件 / Custom select component
 *
 * 基于 Arco Design Select 的封装，提供统一的样式主题和弹出层处理
 * Wrapper around Arco Design Select with unified theme styling and popup handling
 *
 * @features
 * - 自动适配明暗主题 / Auto theme adaptation (light/dark)
 * - 弹出层挂载到 body，避免布局问题 / Popup mounted to body to avoid layout issues
 * - 统一的圆角和边框样式 / Unified border radius and border styles
 * - 完整的 Arco Select API 支持 / Full Arco Select API support
 *
 * @example
 * ```tsx
 * // 基本用法 / Basic usage
 * <MuSelect placeholder="请选择" style={{ width: 200 }}>
 *   <MuSelect.Option value="1">选项1</MuSelect.Option>
 *   <MuSelect.Option value="2">选项2</MuSelect.Option>
 * </MuSelect>
 *
 * // 多选 / Multiple selection
 * <MuSelect mode="multiple" placeholder="请选择多个">
 *   <MuSelect.Option value="1">选项1</MuSelect.Option>
 *   <MuSelect.Option value="2">选项2</MuSelect.Option>
 * </MuSelect>
 *
 * // 分组 / Grouped options
 * <MuSelect placeholder="请选择">
 *   <MuSelect.OptGroup label="分组1">
 *     <MuSelect.Option value="1">选项1</MuSelect.Option>
 *   </MuSelect.OptGroup>
 *   <MuSelect.OptGroup label="分组2">
 *     <MuSelect.Option value="2">选项2</MuSelect.Option>
 *   </MuSelect.OptGroup>
 * </MuSelect>
 * ```
 */
const mapSizeToNative = (size?: MuSelectSize): NativeSelectSize | undefined => {
  if (!size) return undefined;
  if (size === 'middle') return 'default';
  return size;
};

type MuSelectComponent = React.ForwardRefExoticComponent<MuSelectProps & React.RefAttributes<SelectHandle>> & {
  Option: typeof Select.Option;
  OptGroup: typeof Select.OptGroup;
};

const InternalSelect = React.forwardRef<SelectHandle, MuSelectProps>(
  ({ className, getPopupContainer, size = 'middle', ...rest }, ref) => {
    const normalizedSize = mapSizeToNative(size);
    const select = useRef<SelectHandle>(null);
    useImperativeHandle(ref, () => select.current as SelectHandle);
    // In multiple mode the field that takes the focus is Arco's typing input among the tags, which has no name of its
    // own: it gets the select's, so a screen reader says what the field picks. (JSX passes aria-* to any component
    // without it being a declared prop, hence the cast.)
    const label = (rest as { 'aria-label'?: string })['aria-label'];
    const multiple = rest.mode === 'multiple';
    useEffect(() => {
      if (multiple && label) select.current?.dom?.querySelector('input')?.setAttribute('aria-label', label);
    });
    return (
      <Select
        ref={select}
        size={normalizedSize}
        className={classNames(BASE_CLASS, className)}
        getPopupContainer={getPopupContainer || defaultGetPopupContainer}
        {...rest}
      />
    );
  }
);

const MuSelect = InternalSelect as MuSelectComponent;

MuSelect.displayName = 'MuSelect';

// 导出子组件 / Export sub-components
MuSelect.Option = Select.Option;
MuSelect.OptGroup = Select.OptGroup;

export default MuSelect;
