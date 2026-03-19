import ReactEcs, { ReactEcsRenderer, UiEntity } from "@dcl/sdk/react-ecs"


export function setupUi() {
    ReactEcsRenderer.setUiRenderer(uiMenu, { virtualWidth: 1920, virtualHeight: 1080 })
}

// draw your UI here
export const uiMenu = () => (
    <UiEntity>  
    </UiEntity>
)