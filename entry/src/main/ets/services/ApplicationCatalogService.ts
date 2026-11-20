import { abilityAccessCtrl, bundle, bundleManager, common } from '@kit.AbilityKit'
import { resourceManager } from '@kit.LocalizationKit'
import { HARMONY_NET_BUNDLE_NAME, validateApplicationBundleName } from '../domain/NetworkSettings'

export interface SelectableApplication {
  bundleName: string
  label: string
  systemApp?: boolean
  icon?: resourceManager.Resource
}
export interface ApplicationCatalogResult { applications: SelectableApplication[]; state: string; message: string }

/** Full phone inventory requires an approved signing-profile ACL.
 * API26 getInstalledBundleList is enterprise/2in1-only in this SDK.
 * Launcher queries and imported caches are never labelled a successful scan.
 */
export class ApplicationCatalogService {
  async readInstalledApplications(context: common.UIAbilityContext): Promise<ApplicationCatalogResult> {
    const self = await bundleManager.getBundleInfoForSelf(bundleManager.BundleFlag.GET_BUNDLE_INFO_WITH_APPLICATION)
    const granted: abilityAccessCtrl.GrantStatus = abilityAccessCtrl.createAtManager().checkAccessTokenSync(
      self.appInfo.accessTokenId, 'ohos.permission.GET_BUNDLE_INFO_PRIVILEGED')
    if (granted !== abilityAccessCtrl.GrantStatus.PERMISSION_GRANTED) {
      return { applications: [], state: 'permission-required', message: '缺少读取应用列表的签名授权；当前签名不能扫描。需要获批的 GET_BUNDLE_INFO_PRIVILEGED ACL。' }
    }
    // Phone-compatible public legacy API; the newer inventory API is not a
    // consumer-phone capability in the supplied SDK. No hidden API reflection.
    const installed = await bundle.getAllApplicationInfo(bundle.BundleFlag.GET_BUNDLE_DEFAULT)
    const applications: SelectableApplication[] = []
    for (const app of installed) {
      if (app.name === HARMONY_NET_BUNDLE_NAME || applications.some((item: SelectableApplication) => item.bundleName === app.name)) continue
      let name: string
      try { name = validateApplicationBundleName(app.name) } catch (_) { continue }
      const moduleName: string = app.moduleInfos.length > 0 ? app.moduleInfos[0].moduleName : ''
      let label: string = app.label && !app.label.startsWith('$') ? app.label : name
      const labelId: number = Number(app.labelId)
      if (labelId > 0) {
        try { label = context.resourceManager.getStringSync({ id: labelId, bundleName: name, moduleName: moduleName }) }
        catch (_) { /* Missing resources must not hide an installed app. */ }
      }
      const iconId: number = Number(app.iconId)
      const item: SelectableApplication = { bundleName: name, label: label || name, systemApp: app.systemApp }
      if (iconId > 0) item.icon = { id: iconId, bundleName: name, moduleName: moduleName }
      applications.push(item)
    }
    applications.sort((left: SelectableApplication, right: SelectableApplication): number => left.label.localeCompare(right.label, 'zh'))
    return { applications: applications, state: applications.length > 0 ? 'loaded' : 'empty', message: applications.length > 0 ? `已从系统读取 ${applications.length} 个应用` : '系统完整列表接口未返回其他应用' }
  }
}
