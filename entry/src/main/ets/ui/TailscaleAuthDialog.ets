@CustomDialog
export struct TailscaleAuthDialog {
  controller?: CustomDialogController
  uri: string = ''
  surface: string = '#FFFFFF'
  textColor: string = '#202124'

  build() {
    Column({ space: 20 }) {
      Text('认证二维码').fontSize(20).fontColor(this.textColor)
      Column() {
        QRCode(this.uri).width(220).height(220)
          .color(Color.Black).backgroundColor(Color.White)
      }.padding(16).backgroundColor(Color.White).borderRadius(12)
      Text('使用另一台设备扫码完成 Tailscale 登录')
        .fontSize(14).fontColor(this.textColor).textAlign(TextAlign.Center)
      Button('关闭').onClick(() => { this.controller?.close() })
    }.padding(24).borderRadius(24).backgroundColor(this.surface)
  }
}
