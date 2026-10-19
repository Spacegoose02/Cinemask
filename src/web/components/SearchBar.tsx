import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
      <input className="input" type="search" placeholder="Search your library and new releases…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
    </form>
  );
}
