/**
 * The page of a native conversation (`/conversation/native/:id`): a conversation that runs on the native host, pi in
 * a process of its own, with no AionCore and no ACP in its path (docs/native-host-ui.md). It exists only while the
 * main process runs the native host (the default; MU_NATIVE_HOST=0 turns it off); otherwise the route goes home.
 */
import React from 'react';
import { Navigate, useParams } from 'react-router-dom';
import NativeConversationScreen from './components/NativeConversationScreen';
import { useNativeEnabled } from './hooks/useNativeConversations';

const NativeConversationPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const enabled = useNativeEnabled();
  if (enabled === undefined) return null;
  if (!enabled || !id) return <Navigate to='/guid' replace />;
  return <NativeConversationScreen id={id} />;
};

export default NativeConversationPage;
