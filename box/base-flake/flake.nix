{
  description = "box 基础环境:所有沙盒的默认工具链(统一 pin,控制 term1 磁盘)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [ nodejs_20 git tmux ripgrep jq curl gnumake python3 ];
        shellHook = ''
          export LOCALE_ARCHIVE=${pkgs.glibcLocales}/lib/locale/locale-archive
        '';
      };
    };
}
