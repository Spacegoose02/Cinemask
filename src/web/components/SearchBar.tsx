import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../lib/i18n';

export function SearchBar() {
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  return (
    <form
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
      }}
      className="w-full max-w-xl"
    >
      <input className="input" type="search" placeholder={t('Search your library and new releases…')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Search')} />
    </form>
  );
}
