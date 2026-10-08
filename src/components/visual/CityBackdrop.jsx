import { MapPin } from 'lucide-react';
import { Illustration } from './Illustration';
import { CITY_ILLUSTRATION, cityCover, heroImageProps } from './theme';

/**
 * Hero backdrop for a city: bundled photography for trusted cities, otherwise a
 * generic city illustration with the city name over it (never a photo of somewhere else).
 * @param {Record<string, any>} props
 */
export function CityBackdrop({ city, position = 'center 60%' }) {
  const cover = cityCover(city);
  if (cover) {
    return (
      <img
        {...heroImageProps(cover)}
        alt=""
        className="absolute inset-0 -z-20 size-full object-cover"
        style={{ objectPosition: position }}
        fetchPriority="high"
      />
    );
  }
  return (
    <div className="absolute inset-0 -z-20 overflow-hidden bg-[radial-gradient(120%_90%_at_10%_0%,#ff9a3c_0%,#e8553d_38%,#6446c4_100%)]" aria-hidden="true">
      <MapPin className="absolute top-8 right-[8%] size-56 text-white/10" strokeWidth={1} />
      <Illustration src={CITY_ILLUSTRATION} loading="eager" fetchPriority="high" className="absolute inset-0 size-full object-cover object-[center_40%]" />
      <span className="absolute right-[5%] bottom-4 text-[120px] leading-none font-black tracking-tight text-white/15 select-none lg:text-[180px]">{city}</span>
    </div>
  );
}
