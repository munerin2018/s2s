package io.github.munerin2018.s2s;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null) {
            getBridge().triggerWindowJSEvent("s2s:resume");
        }
    }
}
