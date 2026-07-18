import { useEffect } from 'react';
import { CheckCircle, XCircle, X } from 'lucide-react';

export default function Toast({ message, type = 'success', onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);

  return (
    <div className={`toast ${type}`}>
      {type === 'success' ? (
        <CheckCircle size={16} color="var(--green)" />
      ) : (
        <XCircle size={16} color="var(--red)" />
      )}
      <span style={{ flex: 1 }}>{message}</span>
      <button onClick={onClose} className="btn btn-icon btn-ghost" style={{ padding: '2px' }}>
        <X size={13} />
      </button>
    </div>
  );
}
