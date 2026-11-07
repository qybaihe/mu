!ifndef MU_INSTALLER_MESSAGES_NSH
!define MU_INSTALLER_MESSAGES_NSH

!define MU_MSG_INSTALL_FAILED_ZH "mu 安装失败"
!define MU_MSG_INSTALL_FAILED_EN "mu installation failed"

!define MU_MSG_SUGGESTED_ACTION_ZH "建议操作"
!define MU_MSG_SUGGESTED_ACTION_EN "Suggested action"

!define MU_MSG_DIAGNOSTICS_ZH "诊断信息"
!define MU_MSG_DIAGNOSTICS_EN "Diagnostics"

!define MU_MSG_INSTALLER_LOG_ZH "安装日志"
!define MU_MSG_INSTALLER_LOG_EN "Installer log"
!define MU_MSG_BLOCK_SEPARATOR "----------------------------------------"

!define MU_MSG_GENERIC_FAILURE_ZH "安装器无法继续。请查看诊断信息和安装日志路径。"
!define MU_MSG_GENERIC_ACTION_ZH "请关闭上面列出的程序后重新运行安装器。如果没有列出具体程序，请重启 Windows 后再次运行安装器。"

!define MU_MSG_VERIFY_REQUIRED_FILE_EN "mu installation is incomplete. Missing required file:"
!define MU_MSG_VERIFY_REQUIRED_FILE_ZH "mu 安装不完整，缺少必需文件："
!define MU_MSG_VERIFY_REQUIRED_FILE_ACTION_EN "Please reinstall mu or download a newer installer."
!define MU_MSG_VERIFY_REQUIRED_FILE_ACTION_ZH "请重新安装 mu，或下载更新版本的安装器。"

!define MU_MSG_EXTRACT_FAILED_EN "mu could not extract the application files correctly."
!define MU_MSG_EXTRACT_FAILED_ZH "mu 无法正确解压应用文件。"
!define MU_MSG_EXTRACT_FAILED_ACTION_EN "Download a fresh installer and run it again. If it still fails, share the installer log shown below with the mu team."
!define MU_MSG_EXTRACT_FAILED_ACTION_ZH "请重新下载安装器后再次运行。如果仍然失败，请将下方显示的安装日志提供给 mu 团队。"

!define MU_MSG_BUNDLED_BACKEND_INCOMPLETE_EN "mu installed, but the bundled local service resources are incomplete."
!define MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ZH "mu 已安装部分文件，但内置的本地服务资源不完整。"
!define MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ACTION_EN "Download a fresh installer and run it again. If it still fails, share the installer log shown below with the mu team."
!define MU_MSG_BUNDLED_BACKEND_INCOMPLETE_ACTION_ZH "请重新下载安装器后再次运行。如果仍然失败，请将下方显示的安装日志提供给 mu 团队。"

!define MU_MSG_ARCH_MISMATCH_EN "Installation package architecture mismatch."
!define MU_MSG_ARCH_MISMATCH_ZH "安装包架构不匹配。"
!define MU_MSG_ARCH_MISMATCH_ACTION_EN "Download the mu installer that matches this Windows architecture, then run it again."
!define MU_MSG_ARCH_MISMATCH_ACTION_ZH "请下载与当前 Windows 架构匹配的 mu 安装器，然后再次运行。"

!define MU_MSG_UNINSTALLER_COPY_LOCKED_EN "mu could not overwrite the installed uninstaller because it is locked."
!define MU_MSG_UNINSTALLER_COPY_LOCKED_ZH "mu 无法覆盖已安装的卸载器，因为该文件被占用。"
!define MU_MSG_UNINSTALLER_REBUILD_FAILED_EN "mu could not rebuild the missing installed uninstaller."
!define MU_MSG_UNINSTALLER_REBUILD_FAILED_ZH "mu 无法重建缺失的已安装卸载器。"
!define MU_MSG_UNINSTALLER_REBUILD_MISSING_EN "mu rebuilt the uninstaller, but the rebuilt file is still missing."
!define MU_MSG_UNINSTALLER_REBUILD_MISSING_ZH "mu 已尝试重建卸载器，但重建后的文件仍然缺失。"
!define MU_MSG_UNINSTALLER_REPAIR_ACTION_EN "Close mu, restart Windows if needed, then run this installer again."
!define MU_MSG_UNINSTALLER_REPAIR_ACTION_ZH "请关闭 mu，必要时重启 Windows，然后再次运行此安装器。"

!define MU_MSG_OLD_UNINSTALL_FAILED_EN "The previous mu uninstaller returned an error."
!define MU_MSG_OLD_UNINSTALL_FAILED_ZH "之前的 mu 卸载器返回错误。"
!define MU_MSG_OLD_UNINSTALL_ACTION_EN "Close the program listed above, then run this installer again. If no program is listed, restart Windows and run this installer again."
!define MU_MSG_OLD_UNINSTALL_ACTION_ZH "请关闭上面列出的程序后重新运行安装器。如果没有列出具体程序，请重启 Windows 后再次运行安装器。"

!define MU_MSG_REPLACE_LOCKED_EN "mu could not safely replace the previous installation because files are still open."
!define MU_MSG_REPLACE_LOCKED_ZH "mu 无法安全替换之前的安装，因为仍有文件处于打开状态。"
!define MU_MSG_PREVIOUS_FILE_OPEN_EN "mu cannot continue because a file in the previous installation is still open."
!define MU_MSG_PREVIOUS_FILE_OPEN_ZH "mu 无法继续，因为之前安装目录中的某个文件仍处于打开状态。"
!define MU_MSG_REMOVE_PREVIOUS_DIR_EN "mu could not remove the previous installation directory."
!define MU_MSG_REMOVE_PREVIOUS_DIR_ZH "mu 无法删除之前的安装目录。"
!define MU_MSG_CLOSE_SHOWN_FILE_ACTION_EN "Close the application using the file shown in the previous message, then run this installer again. If you are not sure what to close, restart Windows and run this installer again."
!define MU_MSG_CLOSE_SHOWN_FILE_ACTION_ZH "请关闭上一条提示中占用文件的应用，然后再次运行安装器。如果不确定要关闭哪个程序，请重启 Windows 后再次运行安装器。"
!define MU_MSG_CLOSE_INSTALL_DIR_ACTION_EN "Close mu and any file browsers in the install directory, then run this installer again."
!define MU_MSG_CLOSE_INSTALL_DIR_ACTION_ZH "请关闭 mu 以及任何打开安装目录的文件管理器，然后再次运行安装器。"

!define MU_MSG_APP_CANNOT_BE_CLOSED_EN "mu could not finish closing or removing the previous version.$\r$\n$\r$\nClose mu and any program that may be using files in the install folder, then click Retry.$\r$\n$\r$\nIf Retry keeps returning here, click Cancel. The installer will show the failed path, any program reported by Windows Restart Manager, and the installer log."
!define MU_MSG_APP_CANNOT_BE_CLOSED_ZH "mu 无法完成关闭或移除旧版本。$\r$\n$\r$\n请关闭 mu 以及任何可能正在使用安装目录中文件的程序，然后点击重试。$\r$\n$\r$\n如果重试后仍然回到这里，请点击取消。安装器会显示失败路径、Windows Restart Manager 报告的占用程序以及安装日志。"

!define MU_MSG_LOCKER_UNKNOWN_EN "Windows did not identify a specific locking process. Close terminals, editors, and file managers opened in the install folder."
!define MU_MSG_LOCKER_UNKNOWN_ZH "Windows 未识别出具体占用进程。请关闭打开安装目录的终端、编辑器和文件管理器。"
!define MU_MSG_UNKNOWN_PROCESS_EN "unknown process"
!define MU_MSG_UNKNOWN_PROCESS_ZH "未知进程"

!define MU_MSG_FILE_OR_FOLDER_IN_USE_EN "mu cannot continue because a file or folder in the install directory is still in use:"
!define MU_MSG_FILE_OR_FOLDER_IN_USE_ZH "mu 无法继续，因为安装目录中的文件或文件夹仍被占用："
!define MU_MSG_APPLICATION_USING_IT_EN "Application using it:"
!define MU_MSG_APPLICATION_USING_IT_ZH "正在使用它的应用："
!define MU_MSG_CLOSE_LISTED_RETRY_EN "Close the application listed above, then click Retry. If you are not sure what to close, click Cancel to show the diagnostics and installer log."
!define MU_MSG_CLOSE_LISTED_RETRY_ZH "请关闭上面列出的应用，然后点击重试。如果不确定要关闭哪个程序，请点击取消，查看诊断信息和安装日志。"

!define MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_EN "mu could not finish closing or removing the previous version."
!define MU_MSG_CLOSE_OR_REMOVE_PREVIOUS_ZH "mu 无法完成关闭或移除旧版本。"
!define MU_MSG_MAY_USE_INSTALL_DIR_EN "Another program may still be using files in:"
!define MU_MSG_MAY_USE_INSTALL_DIR_ZH "另一个程序可能仍在使用此目录中的文件："
!define MU_MSG_RETRY_AFTER_CLOSING_DIR_EN "Click Retry after closing mu and any program using that folder. Click Cancel to show the diagnostics and installer log."
!define MU_MSG_RETRY_AFTER_CLOSING_DIR_ZH "请关闭 mu 以及任何使用该文件夹的程序后点击重试。点击取消会显示诊断信息和安装日志。"

!endif
