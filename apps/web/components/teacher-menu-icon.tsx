import { faGamepad } from "@fortawesome/free-solid-svg-icons/faGamepad";
import { faPenNib } from "@fortawesome/free-solid-svg-icons/faPenNib";
import { faTrophy } from "@fortawesome/free-solid-svg-icons/faTrophy";
import { faFolderOpen } from "@fortawesome/free-solid-svg-icons/faFolderOpen";
import { faListCheck } from "@fortawesome/free-solid-svg-icons/faListCheck";
import { faAnglesLeft } from "@fortawesome/free-solid-svg-icons/faAnglesLeft";
import { faAnglesRight } from "@fortawesome/free-solid-svg-icons/faAnglesRight";

const icons = { game: faGamepad, strokes: faPenNib, ranking: faTrophy, folders: faFolderOpen, quiz: faListCheck, collapse: faAnglesLeft, expand: faAnglesRight };

/** Font Awesome Free SVGs; import individual definitions, not a font or CDN kit. */
export function TeacherMenuIcon({ name }: { name: keyof typeof icons }) {
  const definition = icons[name];
  const [width, height, , , paths] = definition.icon;
  return <svg className="teacherMenuSvg" data-icon={definition.iconName} aria-hidden="true" focusable="false" viewBox={`0 0 ${width} ${height}`} fill="currentColor">
    {(Array.isArray(paths) ? paths : [paths]).map((path, i) => <path key={i} d={path} />)}
  </svg>;
}
