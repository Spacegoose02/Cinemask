/** The couch raccoon and the name, shown on the sign-in and setup screens. */
export function Brand() {
  return (
    <div className="flex flex-col items-center">
      <img src="/hero.png" alt="Cinemask raccoon on a couch with popcorn" className="h-40 w-40" />
      <div className="text-2xl font-bold tracking-tight">Cinemask</div>
    </div>
  );
}
