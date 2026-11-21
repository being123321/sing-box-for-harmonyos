import { ChoicesCatalog, ProfileChoices, ChoiceCommand, emptyChoices, parseChoices, recordChoice } from '../domain/RuntimeChoices'
import { SecureFileStore } from './SecureFileStore'

// The VPN Extension is the sole writer. Persistent user choices live outside
// the disposable runtime directory, so stop/start/upgrade cleanup cannot clear them.
export class RuntimeChoicesStore {
  private store: SecureFileStore
  constructor(filesDir: string) {
    this.store = new SecureFileStore(filesDir + '/sfa-choices.secure.json', filesDir + '/sfa-choices.json',
      'sfa-choices-v1', 4 * 1024 * 1024, (text: string): void => { parseChoices(text) })
  }
  private async catalog(): Promise<ChoicesCatalog> {
    const text: string | null = await this.store.load()
    return text === null ? { version: 1, profiles: [] } : parseChoices(text)
  }
  async load(profileId: string): Promise<ProfileChoices> {
    const catalog: ChoicesCatalog = await this.catalog()
    return catalog.profiles.find((item: ProfileChoices) => item.profileId === profileId) || emptyChoices(profileId)
  }
  async record(profileId: string, command: ChoiceCommand): Promise<ProfileChoices> {
    const catalog: ChoicesCatalog = await this.catalog()
    const previous: ProfileChoices = catalog.profiles.find((item: ProfileChoices) => item.profileId === profileId) || emptyChoices(profileId)
    const next: ProfileChoices = recordChoice(previous, command)
    catalog.profiles = catalog.profiles.filter((item: ProfileChoices) => item.profileId !== profileId)
    catalog.profiles.push(next)
    const text: string = JSON.stringify(catalog)
    parseChoices(text)
    await this.store.save(text)
    return next
  }
}
