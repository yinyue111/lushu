// U16: enlarge the touch hit area of small inline text links/buttons to >=44px
// on coarse pointers via an invisible ::after, without growing glyphs or layout.
export const TAP_TARGET =
  "relative [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:left-1/2 [@media(pointer:coarse)]:after:top-1/2 [@media(pointer:coarse)]:after:h-11 [@media(pointer:coarse)]:after:w-full [@media(pointer:coarse)]:after:min-w-11 [@media(pointer:coarse)]:after:-translate-x-1/2 [@media(pointer:coarse)]:after:-translate-y-1/2 [@media(pointer:coarse)]:after:content-['']";
