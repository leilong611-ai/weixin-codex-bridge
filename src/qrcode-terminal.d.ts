declare module "qrcode-terminal" {
  interface QrCodeOptions {
    small?: boolean;
  }

  interface QrCodeTerminal {
    generate(
      input: string,
      options: QrCodeOptions,
      callback: (output: string) => void
    ): void;
  }

  const qrcodeTerminal: QrCodeTerminal;
  export default qrcodeTerminal;
}
