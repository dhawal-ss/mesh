/**
 * Curated emoji set for the reaction and composer picker.
 *
 * Intentionally hand-picked rather than a full Unicode dump: it keeps the
 * bundle lean while covering the emoji people actually reach for. Each entry is
 * a compact [char, name, keywords] tuple (the char is inserted/reacted with,
 * the name is the accessible label, keywords are lowercased search terms). The
 * tuple form avoids repeating property names 112 times in the
 * shipped bundle; readable EmojiEntry objects are rebuilt once at load.
 */

export interface EmojiEntry {
  /** The emoji glyph that is inserted or reacted with. */
  char: string
  /** Human-readable name; also the button's accessible label. */
  name: string
  /** Space-separated, lowercased search terms. */
  keywords: string
}

export interface EmojiCategory {
  id: string
  label: string
  emoji: EmojiEntry[]
}

/** Raw, bundle-lean form: [char, name, keywords]. */
type RawEmoji = readonly [char: string, name: string, keywords: string]
interface RawCategory {
  id: string
  label: string
  emoji: readonly RawEmoji[]
}

const RAW_CATEGORIES: readonly RawCategory[] = [
  {
    id: 'smileys',
    label: 'Smileys',
    emoji: [
      ['😀', 'grinning face', 'happy smile grin'],
      ['😄', 'grinning face with smiling eyes', 'happy joy smile'],
      ['😁', 'beaming face', 'happy grin teeth'],
      ['😂', 'face with tears of joy', 'lol laugh cry funny'],
      ['🤣', 'rolling on the floor laughing', 'rofl lol laugh'],
      ['😊', 'smiling face with smiling eyes', 'happy blush warm'],
      ['🙂', 'slightly smiling face', 'smile ok'],
      ['😉', 'winking face', 'wink flirt joke'],
      ['😍', 'smiling face with heart eyes', 'love crush adore'],
      ['🥰', 'smiling face with hearts', 'love adore affection'],
      ['😘', 'face blowing a kiss', 'kiss love'],
      ['😎', 'smiling face with sunglasses', 'cool awesome'],
      ['🤔', 'thinking face', 'think hmm consider'],
      ['🥳', 'partying face', 'party celebrate hooray'],
      ['😅', 'grinning face with sweat', 'relief phew nervous'],
      ['😬', 'grimacing face', 'awkward yikes'],
      ['😢', 'crying face', 'sad tear'],
      ['😭', 'loudly crying face', 'sob sad bawl'],
      ['😡', 'enraged face', 'angry mad rage'],
      ['😱', 'face screaming in fear', 'shock scared omg'],
      ['🤯', 'exploding head', 'mind blown shock wow'],
      ['😴', 'sleeping face', 'sleep tired zzz'],
    ],
  },
  {
    id: 'gestures',
    label: 'Gestures',
    emoji: [
      ['👍', 'thumbs up', 'yes like approve good'],
      ['👎', 'thumbs down', 'no dislike bad'],
      ['👏', 'clapping hands', 'clap applause bravo'],
      ['🙌', 'raising hands', 'celebrate praise hooray'],
      ['🙏', 'folded hands', 'please thanks pray'],
      ['💪', 'flexed biceps', 'strong muscle power'],
      ['🤝', 'handshake', 'deal agree partner'],
      ['✌️', 'victory hand', 'peace two'],
      ['🤞', 'crossed fingers', 'luck hope wish'],
      ['👌', 'ok hand', 'okay perfect good'],
      ['🫶', 'heart hands', 'love care thanks'],
      ['👋', 'waving hand', 'hello hi bye wave'],
      ['🫡', 'saluting face', 'salute respect yes'],
      ['🤙', 'call me hand', 'shaka hang loose'],
    ],
  },
  {
    id: 'hearts',
    label: 'Hearts',
    emoji: [
      ['❤️', 'red heart', 'love like'],
      ['🧡', 'orange heart', 'love'],
      ['💛', 'yellow heart', 'love friend'],
      ['💚', 'green heart', 'love'],
      ['💙', 'blue heart', 'love'],
      ['💜', 'purple heart', 'love'],
      ['🖤', 'black heart', 'love dark'],
      ['🤍', 'white heart', 'love pure'],
      ['💖', 'sparkling heart', 'love sparkle'],
      ['💕', 'two hearts', 'love affection'],
      ['💔', 'broken heart', 'sad heartbreak'],
    ],
  },
  {
    id: 'animals',
    label: 'Animals & nature',
    emoji: [
      ['🐶', 'dog face', 'dog puppy pet'],
      ['🐱', 'cat face', 'cat kitten pet'],
      ['🦊', 'fox', 'fox'],
      ['🐻', 'bear', 'bear'],
      ['🐼', 'panda', 'panda'],
      ['🦁', 'lion', 'lion'],
      ['🐸', 'frog', 'frog'],
      ['🐵', 'monkey face', 'monkey'],
      ['🦄', 'unicorn', 'unicorn magic'],
      ['🐝', 'honeybee', 'bee'],
      ['🦋', 'butterfly', 'butterfly'],
      ['🌸', 'cherry blossom', 'flower spring'],
    ],
  },
  {
    id: 'food',
    label: 'Food & drink',
    emoji: [
      ['🍕', 'pizza', 'pizza food'],
      ['🍔', 'hamburger', 'burger food'],
      ['🍟', 'french fries', 'fries food'],
      ['🌮', 'taco', 'taco food'],
      ['🍣', 'sushi', 'sushi food'],
      ['🍩', 'doughnut', 'donut sweet'],
      ['🍪', 'cookie', 'cookie sweet'],
      ['🎂', 'birthday cake', 'cake birthday'],
      ['☕', 'hot beverage', 'coffee tea'],
      ['🍺', 'beer mug', 'beer drink'],
      ['🥑', 'avocado', 'avocado'],
    ],
  },
  {
    id: 'activity',
    label: 'Activity',
    emoji: [
      ['⚽', 'soccer ball', 'soccer football'],
      ['🏀', 'basketball', 'basketball'],
      ['🎮', 'video game', 'game gaming controller'],
      ['🕹️', 'joystick', 'game arcade'],
      ['🎧', 'headphone', 'music audio'],
      ['🎨', 'artist palette', 'art paint'],
      ['🎸', 'guitar', 'music rock'],
      ['🎯', 'direct hit', 'target bullseye goal'],
      ['🏆', 'trophy', 'win award champion'],
      ['🎲', 'game die', 'dice random'],
      ['🎬', 'clapper board', 'movie film'],
    ],
  },
  {
    id: 'travel',
    label: 'Travel & places',
    emoji: [
      ['🚀', 'rocket', 'launch ship space fast ship'],
      ['✈️', 'airplane', 'flight travel'],
      ['🚗', 'car', 'car drive'],
      ['🏠', 'house', 'home'],
      ['🌍', 'globe', 'earth world'],
      ['⛰️', 'mountain', 'mountain hike'],
      ['🌈', 'rainbow', 'rainbow pride'],
      ['⭐', 'star', 'star favorite'],
      ['🌙', 'crescent moon', 'moon night'],
    ],
  },
  {
    id: 'objects',
    label: 'Objects',
    emoji: [
      ['💻', 'laptop', 'computer code work'],
      ['📱', 'mobile phone', 'phone mobile'],
      ['💡', 'light bulb', 'idea'],
      ['🔧', 'wrench', 'tool fix'],
      ['🔒', 'locked', 'lock secure private'],
      ['🔑', 'key', 'key access'],
      ['📌', 'pushpin', 'pin'],
      ['🎁', 'gift', 'present gift'],
      ['💎', 'gem stone', 'diamond gem'],
      ['⏰', 'alarm clock', 'time clock'],
    ],
  },
  {
    id: 'symbols',
    label: 'Symbols',
    emoji: [
      ['✅', 'check mark', 'yes done ok correct'],
      ['❌', 'cross mark', 'no wrong cancel'],
      ['❓', 'question mark', 'question help'],
      ['❗', 'exclamation mark', 'important alert'],
      ['💯', 'hundred points', 'perfect hundred score'],
      ['🎉', 'party popper', 'celebrate congrats yay'],
      ['✨', 'sparkles', 'shine magic clean'],
      ['⚡', 'high voltage', 'lightning fast power'],
      ['💥', 'collision', 'boom explosion'],
      ['👀', 'eyes', 'look watch see'],
      ['🔥', 'fire', 'lit hot flame burn'],
      ['🚩', 'triangular flag', 'flag report'],
    ],
  },
]

export const EMOJI_CATEGORIES: EmojiCategory[] = RAW_CATEGORIES.map((category) => ({
  id: category.id,
  label: category.label,
  emoji: category.emoji.map(([char, name, keywords]) => ({ char, name, keywords })),
}))

/** Shown as the default top row before anyone has a personal history. */
export const DEFAULT_FREQUENT: string[] = [
  '👍', '❤️', '😂', '🔥', '🎉', '👀', '💯', '✅',
]

/** Char -> entry, built once, for resolving recent/frequent glyphs. */
export const EMOJI_BY_CHAR: ReadonlyMap<string, EmojiEntry> = new Map(
  EMOJI_CATEGORIES.flatMap((category) =>
    category.emoji.map((entry) => [entry.char, entry] as const),
  ),
)
