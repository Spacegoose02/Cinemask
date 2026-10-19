import { Alert } from '../../components/ui';

export function SaveBar({ onSave, saving, message }: { onSave: () => void; saving: boolean; message: { kind: 'error' | 'success'; text: string } | null }) {
  return (
    <div className="flex items-center gap-3">
      <button className="btn-primary" onClick={onSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {message && <Alert kind={message.kind}>{message.text}</Alert>}
    </div>
  );
}
