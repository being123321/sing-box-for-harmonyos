export interface BackgroundSwatch { name: string; color: string }
export const BACKGROUND_SWATCHES: BackgroundSwatch[] = [
  {name:'纯白',color:'#FFFFFF'}, {name:'雾灰',color:'#F0F1F3'},
  {name:'米杏',color:'#F4EDDF'}, {name:'浅粉',color:'#F8E8EF'},
  {name:'薰衣草',color:'#EDE7FA'}, {name:'晴空',color:'#E4F0FC'},
  {name:'薄荷',color:'#E2F3EC'}, {name:'湖青',color:'#DDEFF0'},
  {name:'石墨',color:'#282A30'}, {name:'深蓝',color:'#182538'},
  {name:'墨绿',color:'#172D28'}, {name:'纯黑',color:'#000000'}
]
export function normalizeBackgroundColor(value: string): string {
  const text: string = value.trim()
  const hex: string = text.startsWith('#') ? text.slice(1) : text
  if (/^[\da-f]{3}$/i.test(hex)) return '#' + hex.split('').map((c: string) => c + c).join('').toUpperCase()
  if (/^[\da-f]{6}$/i.test(hex)) return '#' + hex.toUpperCase()
  throw new Error('请输入有效颜色，例如 #E4F0FC')
}
export function backgroundColorIsDark(value: string): boolean {
  const color: string = normalizeBackgroundColor(value)
  return (parseInt(color.slice(1,3),16)*299 + parseInt(color.slice(3,5),16)*587 + parseInt(color.slice(5,7),16)*114)/1000 < 145
}
export function validBackgroundImageName(value: string): boolean { return /^appearance-background-\d+\.img$/.test(value) }
