Place the traced-extension.zip file here.

To generate it:
  cd ../../../extension
  zip -r traced-extension.zip . -x "*.py" -x "*.DS_Store" -x "__MACOSX/*"
  cp traced-extension.zip ../server/public/downloads/

This file will be served at: https://traced.mikaelsyed.me/downloads/traced-extension.zip
